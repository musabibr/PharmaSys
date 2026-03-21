#!/usr/bin/env python3
"""
PDF Invoice Parser for PharmaSys.

Extracts product rows from pharmaceutical vendor invoices using pdfplumber.
Supports multiple vendor formats (Medical Plus/Amipharma, OSUS Group, etc.)
with keyword-based header detection AND data-driven column inference as fallback.

Outputs a JSON array to stdout.

Usage:
    python pdf_invoice_parser.py "path/to/invoice.pdf"

Exit codes:
    0  success (JSON on stdout)
    1  error   (message on stderr)
"""

import sys
import os
import re
import json
import math
from collections import Counter

try:
    import pdfplumber
except ImportError:
    sys.stderr.write(
        'pdfplumber is not installed. Run: pip install pdfplumber\n'
    )
    sys.exit(1)


# ─── Unit normalisation map (mirrors pdf-import.ts UNIT_MAP) ─────────────────

UNIT_MAP = {
    # English (uppercased for case-insensitive match)
    'BOX':      'Box',
    'BOTELL':   'Bottle',
    'BOTTLE':   'Bottle',
    'BOTT':     'Bottle',
    'BOT':      'Bottle',
    'BTL':      'Bottle',
    'TUB':      'Tube',
    'TUBE':     'Tube',
    'STRIP':    'Strip',
    'STRIPT':   'Strip',
    'PCS':      'Piece',
    'PC':       'Piece',
    'PIECE':    'Piece',
    'AMBOLS':   'Ampoule',
    'AMPOULE':  'Ampoule',
    'AMP':      'Ampoule',
    'AMBOL':    'Ampoule',
    'DROP':     'Drop',
    'DROPS':    'Drop',
    'VAIL':     'Vial',
    'VIAL':     'Vial',
    'SACHET':   'Sachet',
    'SUPP':     'Suppository',
    'ROLL':     'Roll',
    'JAR':      'Jar',
    'CAN':      'Can',
    'BAG':      'Bag',
    'UNIT':     'Unit',
    'TAB':      'Tablet',
    'TABLET':   'Tablet',
    'CAPSULE':  'Capsule',
    'CAP':      'Capsule',
    'DOZEN':    'Dozen',
    'DOZ':      'Dozen',
    'PACK':     'Pack',
    'PACKET':   'Pack',
    'PKT':      'Pack',
    'SYRUP':    'Bottle',
    'CREAM':    'Tube',
    'OINTMENT': 'Tube',
    'GEL':      'Tube',
    'SPRAY':    'Bottle',
    'INJ':      'Ampoule',
    'SUSP':     'Bottle',
    # Arabic
    'علبة':     'Box',
    'علب':      'Box',
    'قارورة':   'Bottle',
    'زجاجة':    'Bottle',
    'أنبوب':    'Tube',
    'أنبوبة':   'Tube',
    'شريط':     'Strip',
    'شرائط':    'Strip',
    'قطعة':     'Piece',
    'حبة':      'Piece',
    'أمبول':    'Ampoule',
    'أمبولة':   'Ampoule',
    'قطرة':     'Drop',
    'قطرات':    'Drop',
    'فيال':     'Vial',
    'كيس':      'Sachet',
    'أكياس':    'Sachet',
    'تحميلة':   'Suppository',
    'تحاميل':   'Suppository',
    'لفة':      'Roll',
    'برطمان':   'Jar',
    'عبوة':     'Unit',
    'وحدة':     'Unit',
    'كبسولة':   'Capsule',
    'قرص':      'Tablet',
    'أقراص':    'Tablet',
}

# Set of known unit strings (uppercased) for data-driven inference
_KNOWN_UNITS_UPPER = set(UNIT_MAP.keys()) | {v.upper() for v in UNIT_MAP.values()}

# Footer / summary lines to skip
FOOTER_KEYWORDS = [
    'الإجمالي', 'اجمالي', 'الاجمالي', 'يلامجا',
    'المبلغ كتابة', 'المبلغ المطلوب',
    'Page', 'page', 'صفحة', 'ةحفص',
    'Total', 'TOTAL', 'Sub Total', 'SUB TOTAL', 'SUBTOTAL',
    'Grand Total', 'GRAND TOTAL',
    'ملاحظات', 'شروط', 'تاظحلام',
    'Discount', 'discount', 'خصم',
    'Tax', 'VAT', 'ضريبة',
]


# ─── Helpers ─────────────────────────────────────────────────────────────────

def normalise_unit(raw: str) -> str:
    """Map a raw unit string to a canonical name."""
    s = raw.strip()
    if not s:
        return ''
    # Try exact match (Arabic)
    if s in UNIT_MAP:
        return UNIT_MAP[s]
    # Try uppercased (English)
    up = s.upper()
    if up in UNIT_MAP:
        return UNIT_MAP[up]
    return s


def is_known_unit(s: str) -> bool:
    """Check if a string matches a known unit (case-insensitive)."""
    if not s:
        return False
    return s.strip().upper() in _KNOWN_UNITS_UPPER or s.strip() in UNIT_MAP


def parse_unit_string(raw: str) -> dict:
    """
    Parse compound unit strings like 'BOX/3 STRIP', 'STRIP/3BOX',
    'BOX/2STRIP', etc. into {parent_unit, child_unit, conversion_factor}.
    """
    s = raw.strip()
    if not s:
        return {'parent_unit': 'Unit', 'child_unit': '', 'conversion_factor': 1}

    # Pattern: PARENT/NNN CHILD  or  PARENT/NNNCHILD
    # e.g. BOX/3 STRIP, STRIP/3BOX, BOX/2STRIP, BOTTLE/10 TAB
    compound = re.match(
        r'^([A-Za-z\u0600-\u06FF]+)\s*/\s*(\d+)\s*([A-Za-z\u0600-\u06FF]+)$',
        s
    )
    if compound:
        parent_raw = compound.group(1)
        factor = int(compound.group(2))
        child_raw = compound.group(3)
        return {
            'parent_unit': normalise_unit(parent_raw),
            'child_unit': normalise_unit(child_raw),
            'conversion_factor': factor or 1,
        }

    # Pattern: PARENT/NNN (number-only child — treat as conversion factor)
    compound_no_child = re.match(
        r'^([A-Za-z\u0600-\u06FF]+)\s*/\s*(\d+)$',
        s
    )
    if compound_no_child:
        parent_raw = compound_no_child.group(1)
        factor = int(compound_no_child.group(2))
        return {
            'parent_unit': normalise_unit(parent_raw),
            'child_unit': '',
            'conversion_factor': factor or 1,
        }

    # Simple unit
    return {
        'parent_unit': normalise_unit(s),
        'child_unit': '',
        'conversion_factor': 1,
    }


def convert_date(date_str: str) -> str:
    """Convert various date formats to YYYY-MM-DD. Returns empty string on failure."""
    s = date_str.strip()
    if not s:
        return ''

    # Handle Arabic-Indic digits (٠١٢٣٤٥٦٧٨٩)
    arabic_indic = str.maketrans('٠١٢٣٤٥٦٧٨٩', '0123456789')
    s = s.translate(arabic_indic)

    # Already YYYY-MM-DD?
    m = re.match(r'^(\d{4})-(\d{1,2})-(\d{1,2})$', s)
    if m:
        yyyy, mm, dd = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if 1 <= mm <= 12 and 1 <= dd <= 31:
            return f'{yyyy}-{str(mm).zfill(2)}-{str(dd).zfill(2)}'
        return ''

    # DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY
    m = re.match(r'^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$', s)
    if m:
        a, b, yyyy = int(m.group(1)), int(m.group(2)), int(m.group(3))
        # If first number > 12, it must be day (DD/MM/YYYY)
        # If second number > 12, it must be day (MM/DD/YYYY)
        # Default: assume DD/MM/YYYY (common in Middle East)
        if a > 12 and b <= 12:
            dd, mm = a, b
        elif b > 12 and a <= 12:
            dd, mm = b, a
        else:
            dd, mm = a, b  # default DD/MM/YYYY
        if 1 <= mm <= 12 and 1 <= dd <= 31:
            return f'{yyyy}-{str(mm).zfill(2)}-{str(dd).zfill(2)}'
        return ''

    # YYYY/MM/DD or YYYY-MM-DD or YYYY.MM.DD
    m = re.match(r'^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})$', s)
    if m:
        yyyy, mm, dd = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if 1 <= mm <= 12 and 1 <= dd <= 31:
            return f'{yyyy}-{str(mm).zfill(2)}-{str(dd).zfill(2)}'
        return ''

    # MM/YYYY (no day — common on price lists; use day=01)
    m = re.match(r'^(\d{1,2})[/\-.](\d{4})$', s)
    if m:
        mm, yyyy = int(m.group(1)), int(m.group(2))
        if 1 <= mm <= 12:
            return f'{yyyy}-{str(mm).zfill(2)}-01'
        return ''

    return ''


def clean_price(val: str) -> int:
    """Parse a price string to whole SDG integer. Handles European format (7.260,50)."""
    s = val.strip()
    if not s:
        return 0

    # Remove currency symbols and whitespace
    s = re.sub(r'[^\d,.\-]', '', s)
    if not s:
        return 0

    # Detect European format: period as thousands, comma as decimal
    # e.g. "7.260,50" or "1.234.567,89"
    if re.search(r'\.\d{3}[,]', s) or (re.search(r'\.\d{3}$', s) and ',' not in s and s.count('.') > 1):
        # European: swap . and ,
        s = s.replace('.', '').replace(',', '.')
    else:
        # Standard: remove commas (thousands separators)
        s = s.replace(',', '')

    try:
        result = round(float(s))
        return abs(result)  # prices can't be negative
    except ValueError:
        return 0


def clean_int(val: str) -> int:
    """Parse an integer string, ignoring non-numeric chars."""
    s = val.strip()
    if not s:
        return 0
    # Remove commas, spaces
    s = s.replace(',', '').replace(' ', '')
    try:
        result = int(float(s))
        return abs(result)  # quantities can't be negative
    except ValueError:
        return 0


def is_footer_row(cells: list) -> bool:
    """Check if a row is a footer/summary row that should be skipped."""
    text = ' '.join(str(c) for c in cells if c)
    if not text.strip():
        return True
    # Check for footer keywords
    if any(kw in text for kw in FOOTER_KEYWORDS):
        return True
    # Page number pattern: "1 of 5", "1 من 5", "صفحة 2"
    if re.match(r'^\s*\d+\s*(of|من|/)\s*\d+\s*$', text):
        return True
    return False


# ─── Value type detection (for data-driven column inference) ─────────────────

# Date pattern: DD/MM/YYYY, MM/YYYY, YYYY-MM-DD, etc.
_DATE_RE = re.compile(
    r'^\d{1,2}[/\-.]\d{1,2}[/\-.]\d{4}$|'
    r'^\d{4}[/\-.]\d{1,2}[/\-.]\d{1,2}$|'
    r'^\d{1,2}[/\-.]\d{4}$'
)

# Price pattern: number with optional commas/periods/spaces (e.g. 4,400.00, 7.260,50)
_PRICE_RE = re.compile(r'^[\d,.\s]+$')

# Sequential integer pattern
_INT_RE = re.compile(r'^\d{1,5}$')


def _cell_looks_like_date(val: str) -> bool:
    """Check if a cell value looks like a date."""
    s = val.strip()
    if not s:
        return False
    # Translate Arabic-Indic digits
    s = s.translate(str.maketrans('٠١٢٣٤٥٦٧٨٩', '0123456789'))
    return bool(_DATE_RE.match(s))


def _cell_looks_like_price(val: str) -> bool:
    """Check if a cell value looks like a price (number with formatting)."""
    s = val.strip()
    if not s:
        return False
    # Must contain at least one digit and be purely numeric with separators
    s = re.sub(r'[^\d,.\s]', '', s)
    return bool(s) and bool(re.search(r'\d', s)) and bool(_PRICE_RE.match(s))


def _cell_looks_like_unit(val: str) -> bool:
    """Check if a cell value looks like a known pharmaceutical unit."""
    return is_known_unit(val)


def _cell_looks_like_name(val: str) -> bool:
    """Check if a cell value looks like a product name (has letters, reasonably long)."""
    s = val.strip()
    if not s or len(s) < 3:
        return False
    # Must contain letters (Latin or Arabic)
    if not re.search(r'[A-Za-z\u0600-\u06FF]', s):
        return False
    # Should not be purely a unit name
    if is_known_unit(s):
        return False
    return True


# Regex: contiguous Arabic block (may include spaces, parens, commas between
# Arabic chars).  Single Arabic char also matches.
_ARABIC_BLOCK_RE = re.compile(
    r'[\u0600-\u06FF][\u0600-\u06FF\s(),،\-]*[\u0600-\u06FF]|[\u0600-\u06FF]'
)

# Parentheses swap table — used after reversing an Arabic block
_PAREN_SWAP = str.maketrans('()', ')(')


def fix_reversed_arabic(text: str) -> str:
    """Reverse Arabic-script segments that PDF extraction stored in visual order.

    pdfplumber extracts RTL text in LTR visual order, so Arabic chars are
    character-reversed.  This function detects contiguous Arabic blocks
    (including spaces/parens between Arabic chars), reverses them, and
    swaps parentheses back to the correct orientation.

    Also fixes reversed parentheses: )text( → (text) when the content
    is Arabic or was part of the reversed text.
    """
    if not text:
        return text

    def _reverse_block(m: re.Match) -> str:
        s = m.group()[::-1]
        # After reversing, swap ( ↔ ) since they were in visual order
        return s.translate(_PAREN_SWAP)

    fixed = _ARABIC_BLOCK_RE.sub(_reverse_block, text)

    # Fix reversed parentheses: )content( → (content)
    # This handles cases where parens are outside the Arabic block
    fixed = re.sub(r'\)([^()]+)\(', r'(\1)', fixed)

    return fixed


def extract_generic_name(product_name: str) -> str:
    """Extract generic/scientific name from parentheses, e.g. 'Product (Generic)'."""
    # Normal parentheses (after Arabic fix has been applied)
    m = re.search(r'\(([^)]+)\)', product_name)
    if m:
        return m.group(1).strip()
    return ''


# ─── Column identification ───────────────────────────────────────────────────

# Column header keywords for identification.
# PDFs may store Arabic text in reversed char order (LTR encoding of RTL text),
# so we include both normal and reversed forms.
# Ordered list — checked in this order to avoid ambiguity.
# 'code' comes right after 'index' to prevent code columns matching as name.
# 'price' must come before 'unit' because "ةدحولا رعس" (unit price) contains
# both the word for "unit" and "price". We want it matched as 'price'.
COLUMN_PATTERNS_ORDERED = [
    ('index',    [r'^#$', r'^م$', r'^رقم$', r'^مقر$', r'^No\.?$', r'^S/?N$', r'^Sl\.?$']),
    ('code',     [r'رقم الصنف', r'فنصلا مقر', r'Code', r'SKU', r'Barcode',
                  r'باركود', r'دوكراب', r'رمز', r'زمر', r'Item\s*No',
                  r'HSN', r'SAC']),
    ('name',     [r'الصنف', r'فنصلا', r'صنف', r'فنص', r'اسم', r'مسا',
                  r'المنتج', r'جتنملا', r'Product', r'Item', r'Description',
                  r'البيان', r'نايبلا', r'الوصف', r'فصولا',
                  r'Designation', r'Article', r'Desc\.?']),
    ('expiry',   [r'[Ee]xp', r'انتهاء', r'ءاهتنا', r'صلاحية', r'ةيحلاص',
                  r'Expiry', r'expiry',
                  # Broad Arabic substring — matches all ligature/encoding variants:
                  # ةيحﻼصلا (U+FEFC ligature), ةيحلصلا, ةيحلاص, etc.
                  r'ةيح', r'خيرات',
                  r'تاريخ', r'Date']),
    ('quantity', [r'الكمية', r'ةيمكلا', r'كمية', r'ةيمك', r'Qty', r'QTY', r'Quantity',
                  r'QUANTIT', r'Qté', r'Count', r'العدد', r'ددعلا', r'عدد']),
    ('total',    [r'الجملة', r'ةلمجلا', r'المجموع', r'عومجملا',
                  r'إجمالي', r'يلامجإ', r'Total', r'TOTAL', r'Amount',
                  r'Montant', r'المبلغ', r'غلبملا', r'Sum']),
    # 'price' MUST come before 'unit' — "ةدحولا رعس" = "unit price"
    # 'whole' is used by OSUS Group invoices as the price column header
    ('price',    [r'سعر الوحدة', r'ةدحولا رعس', r'سعر', r'رعس',
                  r'Price', r'PRICE', r'Unit Price', r'السعر', r'رعسلا',
                  r'whole',  # OSUS Group format
                  r'P\.?U\.?', r'Rate', r'ثمن', r'نمث', r'Cost']),
    ('unit',     [r'الوحدة', r'ةدحولا', r'وحدة', r'ةدحو', r'Unit', r'UNIT',
                  r'Packing', r'Pack', r'Form', r'التعبئة', r'ةئبعتلا']),
    ('bonus',    [r'بونص', r'صنوب', r'Bonus', r'BONUS', r'مجاني', r'Free']),
]


def identify_columns(header_cells: list) -> dict:
    """
    Match header cells to semantic columns.
    Returns a dict mapping semantic name → column index.

    Uses keyword patterns that include reversed Arabic text (common in PDF
    extraction where RTL text is stored in LTR character order).
    Checks patterns in priority order so 'price' matches before 'unit'.
    """
    mapping = {}
    assigned_indices = set()

    # Process in priority order
    for col_name, patterns in COLUMN_PATTERNS_ORDERED:
        for idx, cell in enumerate(header_cells):
            if idx in assigned_indices:
                continue
            cell_text = str(cell).strip() if cell else ''
            if not cell_text:
                continue
            for pat in patterns:
                if re.search(pat, cell_text, re.IGNORECASE):
                    mapping[col_name] = idx
                    assigned_indices.add(idx)
                    break
            if col_name in mapping:
                break

    return mapping


def identify_columns_positional(header_cells: list, num_cols: int) -> dict:
    """
    Fallback: if keyword matching fails, try positional identification
    based on common invoice layouts.

    Supports multiple known layouts anchored on recognisable cells.
    """
    mapping = {}

    # Find anchors: '#', 'م', 'Exp' etc.
    index_pos = None
    for idx, cell in enumerate(header_cells):
        cell_text = str(cell).strip() if cell else ''
        if cell_text in ('#', 'م', 'No', 'No.'):
            index_pos = idx
        elif re.search(r'[Ee]xp', cell_text):
            mapping['expiry'] = idx

    # ── RTL 7-column: '#' or 'م' at last position ──
    if index_pos == num_cols - 1 and num_cols == 7:
        mapping['total'] = 0
        mapping['price'] = 1
        mapping['quantity'] = 2
        mapping['unit'] = 3
        mapping['expiry'] = 4
        mapping['name'] = 5
        mapping['index'] = 6
        return mapping

    # ── LTR 7-column: '#' at position 0 ──
    if index_pos == 0 and num_cols == 7:
        mapping['index'] = 0
        mapping['name'] = 1
        mapping['expiry'] = 2
        mapping['unit'] = 3
        mapping['quantity'] = 4
        mapping['price'] = 5
        mapping['total'] = 6
        return mapping

    # ── OSUS 6-column RTL: [price, expiry, unit, name, code, index='م'] ──
    if index_pos == num_cols - 1 and num_cols == 6:
        mapping['price'] = 0
        mapping['expiry'] = 1
        mapping['unit'] = 2
        mapping['name'] = 3
        mapping['code'] = 4
        mapping['index'] = 5
        return mapping

    # ── OSUS 5-column RTL: [price, unit, name, code, index='م'] (no expiry) ──
    if index_pos == num_cols - 1 and num_cols == 5:
        mapping['price'] = 0
        mapping['unit'] = 1
        mapping['name'] = 2
        mapping['code'] = 3
        mapping['index'] = 4
        return mapping

    # ── LTR 8-column ──
    if index_pos == 0 and num_cols == 8:
        mapping['index'] = 0
        mapping['name'] = 1
        mapping['code'] = 2
        mapping['unit'] = 3
        mapping['expiry'] = 4
        mapping['quantity'] = 5
        mapping['price'] = 6
        mapping['total'] = 7
        return mapping

    # ── RTL 8-column ──
    if index_pos == num_cols - 1 and num_cols == 8:
        mapping['total'] = 0
        mapping['price'] = 1
        mapping['quantity'] = 2
        mapping['expiry'] = 3
        mapping['unit'] = 4
        mapping['name'] = 5
        mapping['code'] = 6
        mapping['index'] = 7
        return mapping

    if index_pos is not None:
        mapping['index'] = index_pos

    return mapping


def infer_columns_from_data(table: list, start_row: int, num_cols: int) -> dict:
    """
    Data-driven column inference: analyze actual cell values to determine
    which column is name, price, date, unit, index, etc.

    This is the ultimate fallback when header keyword matching AND positional
    matching both fail. Works with any language or header text.
    """
    if start_row >= len(table) or num_cols < 2:
        return {}

    # Sample up to 10 data rows for analysis
    sample_rows = table[start_row:start_row + 10]
    if not sample_rows:
        return {}

    # Score each column for each type
    col_scores = {i: {
        'date': 0, 'price': 0, 'int': 0, 'unit': 0, 'name': 0,
        'total_filled': 0, 'avg_len': 0,
    } for i in range(num_cols)}

    for row in sample_rows:
        for i in range(min(num_cols, len(row))):
            val = str(row[i] or '').strip()
            if not val:
                continue
            col_scores[i]['total_filled'] += 1
            col_scores[i]['avg_len'] += len(val)

            if _cell_looks_like_date(val):
                col_scores[i]['date'] += 1
            elif _cell_looks_like_unit(val):
                col_scores[i]['unit'] += 1
            elif _cell_looks_like_price(val) and len(val) >= 2:
                # Distinguish price (larger numbers) from index (small integers)
                try:
                    num = float(val.replace(',', '').replace(' ', ''))
                    if num > 50:
                        col_scores[i]['price'] += 1
                    else:
                        col_scores[i]['int'] += 1
                except ValueError:
                    col_scores[i]['price'] += 1
            elif _INT_RE.match(val):
                col_scores[i]['int'] += 1

            if _cell_looks_like_name(val):
                col_scores[i]['name'] += 1

    # Normalise avg_len
    for i in col_scores:
        if col_scores[i]['total_filled'] > 0:
            col_scores[i]['avg_len'] /= col_scores[i]['total_filled']

    n_rows = len(sample_rows)
    mapping = {}
    assigned = set()

    # 1. Find INDEX: column with sequential small integers (1, 2, 3...)
    best_index = None
    best_index_score = 0
    for i, scores in col_scores.items():
        if scores['int'] >= n_rows * 0.6 and scores['avg_len'] <= 4:
            # Check if values are sequential
            vals = []
            for row in sample_rows:
                v = str(row[i] or '').strip() if i < len(row) else ''
                if _INT_RE.match(v):
                    vals.append(int(v))
            if vals and vals == list(range(vals[0], vals[0] + len(vals))):
                if scores['int'] > best_index_score:
                    best_index = i
                    best_index_score = scores['int']
    if best_index is not None:
        mapping['index'] = best_index
        assigned.add(best_index)

    # 2. Find EXPIRY: column with date-like values
    best_date = None
    best_date_score = 0
    for i, scores in col_scores.items():
        if i in assigned:
            continue
        if scores['date'] > best_date_score:
            best_date = i
            best_date_score = scores['date']
    if best_date is not None and best_date_score >= n_rows * 0.3:
        mapping['expiry'] = best_date
        assigned.add(best_date)

    # 3. Find UNIT: column with known unit strings
    best_unit = None
    best_unit_score = 0
    for i, scores in col_scores.items():
        if i in assigned:
            continue
        if scores['unit'] > best_unit_score:
            best_unit = i
            best_unit_score = scores['unit']
    if best_unit is not None and best_unit_score >= n_rows * 0.3:
        mapping['unit'] = best_unit
        assigned.add(best_unit)

    # 4. Find NAME: column with longest text, containing letters
    best_name = None
    best_name_len = 0
    for i, scores in col_scores.items():
        if i in assigned:
            continue
        if scores['name'] >= n_rows * 0.3 and scores['avg_len'] > best_name_len:
            best_name = i
            best_name_len = scores['avg_len']
    if best_name is not None:
        mapping['name'] = best_name
        assigned.add(best_name)

    # 5. Find PRICE: column with numeric values (larger numbers)
    price_candidates = []
    for i, scores in col_scores.items():
        if i in assigned:
            continue
        if scores['price'] >= n_rows * 0.3:
            price_candidates.append((i, scores['price'], scores['avg_len']))

    if price_candidates:
        # If multiple price columns: the one with larger avg values is likely price,
        # the other is total. Pick by average length (longer = total usually)
        price_candidates.sort(key=lambda x: x[2])  # sort by avg_len ascending
        mapping['price'] = price_candidates[0][0]
        assigned.add(price_candidates[0][0])
        if len(price_candidates) > 1:
            mapping['total'] = price_candidates[-1][0]
            assigned.add(price_candidates[-1][0])

    # 6. Any remaining integer column could be quantity
    for i, scores in col_scores.items():
        if i in assigned:
            continue
        if scores['int'] >= n_rows * 0.3 or scores['price'] >= n_rows * 0.2:
            mapping['quantity'] = i
            assigned.add(i)
            break

    return mapping


# ─── Main extraction ─────────────────────────────────────────────────────────

def _is_header_like(row: list) -> bool:
    """Check if a row looks like a header (mostly non-numeric text, no sequential index)."""
    if not row:
        return False
    non_empty = [str(c).strip() for c in row if c and str(c).strip()]
    if not non_empty:
        return False
    # If most cells contain letters (not just numbers), it's likely a header
    letter_cells = sum(1 for c in non_empty if re.search(r'[A-Za-z\u0600-\u06FF]', c))
    return letter_cells >= len(non_empty) * 0.5


def _extract_via_words(pdf_path: str) -> list:
    """Word-based extraction fallback.

    When pdfplumber's extract_tables() fails (e.g. PDFs without proper grid
    borders), extract words with positions, cluster into rows by Y coordinate,
    and assign columns using the header's X boundaries.
    """
    results = []
    row_number = 0

    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            words = page.extract_words(keep_blank_chars=True)
            if not words:
                continue

            # Cluster words into rows by Y coordinate (top position)
            y_tolerance = 6
            sorted_words = sorted(words, key=lambda w: w['top'])
            text_rows = []
            current_row_words = [sorted_words[0]]
            current_y = sorted_words[0]['top']

            for w in sorted_words[1:]:
                if abs(w['top'] - current_y) <= y_tolerance:
                    current_row_words.append(w)
                else:
                    text_rows.append(sorted(current_row_words, key=lambda w: w['x0']))
                    current_row_words = [w]
                    current_y = w['top']
            if current_row_words:
                text_rows.append(sorted(current_row_words, key=lambda w: w['x0']))

            # Find header row
            header_idx = -1
            header_words = None
            for i, row_words in enumerate(text_rows):
                row_text = ' '.join(w['text'] for w in row_words)
                # Check for known header keywords (include reversed Arabic from pdfplumber)
                has_name = any(kw in row_text for kw in [
                    'Item', 'Product', 'Description', 'DESCRIPTION',
                    'الصنف', 'اسم', 'فنصلا', 'مسا',  # reversed Arabic
                ])
                has_data = any(kw in row_text for kw in [
                    'Exp', 'EXPIRE', 'Qty', 'Quantity', 'QUANTIT', 'Unit', 'UNIT',
                    'Price', 'PRICE', 'Amount', 'Total', 'TOTAL',
                    'الكمية', 'الوحدة', 'السعر', 'الصلاحية',
                    'ةيمكلا', 'ةدحولا', 'رعسلا', 'ةيحلاص',  # reversed Arabic
                ])
                if has_name and has_data:
                    header_idx = i
                    header_words = row_words
                    break

            if header_idx < 0 or not header_words:
                continue

            # Build column boundaries from header words
            # Group header words that are close together into column headers
            def _word_right(w):
                return w.get('x1', w['x0'] + len(w['text']) * 5)

            col_groups = []
            current_group = [header_words[0]]
            for w in header_words[1:]:
                prev_end = _word_right(current_group[-1])
                if w['x0'] - prev_end < 15:  # close enough = same column header
                    current_group.append(w)
                else:
                    col_groups.append(current_group)
                    current_group = [w]
            col_groups.append(current_group)

            # Each column group → header text + X boundaries
            col_headers = []
            for group in col_groups:
                text = ' '.join(w['text'] for w in group)
                left = min(w['x0'] for w in group)
                right = max(_word_right(w) for w in group)
                col_headers.append({'text': text, 'left': left, 'right': right})

            # Build column boundaries as midpoints between adjacent columns
            col_bounds = []
            for ci, ch in enumerate(col_headers):
                mid_left = ch['left'] if ci == 0 else (col_headers[ci - 1]['right'] + ch['left']) / 2
                mid_right = ch['right'] if ci == len(col_headers) - 1 else (ch['right'] + col_headers[ci + 1]['left']) / 2
                col_bounds.append((mid_left, mid_right))

            # Identify semantic columns from header text
            header_cells = [ch['text'] for ch in col_headers]
            col_map = identify_columns(header_cells)
            if 'name' not in col_map:
                continue

            # Process data rows after header
            # Sometimes the next row after header repeats or is empty — check for continuation lines
            pending_name = ''
            for row_words in text_rows[header_idx + 1:]:
                row_text = ' '.join(w['text'] for w in row_words)

                # Skip separator rows (underscores, dashes)
                stripped = row_text.replace(' ', '')
                if stripped and all(c in '_-=' for c in stripped):
                    continue

                if is_footer_row([row_text]):
                    continue

                # Assign each word to a column based on X position
                cells = [''] * len(col_headers)
                for w in row_words:
                    wx = w['x0']
                    best_col = -1
                    best_dist = float('inf')
                    for ci, (bl, br) in enumerate(col_bounds):
                        if bl <= wx <= br:
                            best_col = ci
                            break
                        mid = (bl + br) / 2
                        dist = abs(wx - mid)
                        if dist < best_dist:
                            best_dist = dist
                            best_col = ci
                    if 0 <= best_col < len(cells):
                        if cells[best_col]:
                            cells[best_col] += ' ' + w['text']
                        else:
                            cells[best_col] = w['text']

                # Check for row number (index)
                index_val = ''
                if 'index' in col_map and col_map['index'] < len(cells):
                    index_val = cells[col_map['index']].strip()
                has_index = bool(re.match(r'^\d+$', index_val))

                def get_cell(col_name):
                    if col_name not in col_map:
                        return ''
                    idx = col_map[col_name]
                    return cells[idx].strip() if idx < len(cells) else ''

                name_val = get_cell('name')

                if has_index and name_val:
                    # Save previous record if name continuation was pending
                    if pending_name:
                        name_val = pending_name + ' ' + name_val
                        pending_name = ''

                    row_number += 1
                    fixed_name = fix_reversed_arabic(name_val)
                    qty = clean_int(get_cell('quantity'))
                    if qty == 0 and 'quantity' not in col_map:
                        qty = 1
                    cost = clean_price(get_cell('price'))
                    total = clean_price(get_cell('total'))
                    unit_info = parse_unit_string(get_cell('unit'))
                    generic = extract_generic_name(fixed_name)
                    expiry_val = get_cell('expiry')

                    if cost == 0 and total > 0 and qty > 0:
                        cost = total // qty
                    if total == 0 and cost > 0 and qty > 0:
                        total = cost * qty

                    results.append({
                        'row_number': row_number,
                        'name': fixed_name,
                        'generic_name': generic,
                        'code': get_cell('code'),
                        'expiry_date': convert_date(expiry_val),
                        'parent_unit': unit_info['parent_unit'],
                        'child_unit': unit_info['child_unit'],
                        'conversion_factor': unit_info['conversion_factor'],
                        'quantity': qty,
                        'cost_per_parent': cost,
                        'line_total': total,
                        'validation_error': False,
                    })

                elif not has_index and name_val:
                    # Continuation line — append to previous or hold for next
                    if results:
                        results[-1]['name'] += ' ' + fix_reversed_arabic(name_val)
                        generic = extract_generic_name(results[-1]['name'])
                        if generic:
                            results[-1]['generic_name'] = generic
                    else:
                        pending_name += (' ' + name_val) if pending_name else name_val

    return results


def extract_rows(pdf_path: str) -> list:
    """Extract product rows from a PDF invoice.

    Strategy:
    1. For each page, extract tables via pdfplumber
    2. For each table, try keyword-based header identification
    3. If that fails, try positional identification
    4. If that fails, try data-driven inference (analyze actual values)
    5. Carry forward col_map across pages for multi-page tables without headers
    6. If table extraction yields no results, fall back to word-based extraction
    """
    results = []
    row_number = 0

    # Cross-page state: remember last successful column mapping
    last_col_map = None
    last_num_cols = 0

    with pdfplumber.open(pdf_path) as pdf:
        for page_idx, page in enumerate(pdf.pages):
            tables = page.extract_tables()
            if not tables:
                continue

            for table in tables:
                if not table or len(table) < 2:
                    continue

                num_cols = max(len(r) for r in table if r) if table else 0

                # ── Phase 1: Try keyword-based header identification ──
                col_map = None
                header_row_idx = -1

                for i, row in enumerate(table):
                    if i > 5:
                        # Don't search too deep — header is typically in first few rows
                        break

                    candidate = identify_columns(row)
                    # Need at least name + one numeric column
                    if 'name' in candidate and ('quantity' in candidate or 'price' in candidate or 'total' in candidate):
                        col_map = candidate
                        header_row_idx = i
                        break

                # ── Phase 2: Try positional identification ──
                if col_map is None:
                    for i, row in enumerate(table):
                        if i > 3:
                            break
                        n = len(row) if row else 0
                        if n >= 5:
                            candidate = identify_columns_positional(row, n)
                            if 'name' in candidate and ('quantity' in candidate or 'price' in candidate or 'total' in candidate):
                                col_map = candidate
                                header_row_idx = i
                                break

                # ── Phase 3: Data-driven inference ──
                if col_map is None:
                    # Try to find the first data row (skip header-like rows)
                    data_start = 0
                    for i, row in enumerate(table):
                        if i > 3:
                            break
                        if _is_header_like(row):
                            data_start = i + 1
                        else:
                            break

                    candidate = infer_columns_from_data(table, data_start, num_cols)
                    if 'name' in candidate and ('price' in candidate or 'total' in candidate):
                        col_map = candidate
                        header_row_idx = data_start - 1 if data_start > 0 else -1

                # ── Phase 4: Reuse cross-page col_map ──
                if col_map is None and last_col_map is not None:
                    # Reuse previous page's mapping if column count is similar
                    if abs(num_cols - last_num_cols) <= 1:
                        col_map = last_col_map
                        # Find data start: skip any header-like rows
                        header_row_idx = -1
                        for i, row in enumerate(table):
                            if i > 2:
                                break
                            if _is_header_like(row):
                                header_row_idx = i
                            else:
                                break

                if col_map is None:
                    continue

                # Remember for cross-page continuity
                last_col_map = col_map
                last_num_cols = num_cols

                # ── Process data rows ──
                current_record = None

                for row in table[header_row_idx + 1:]:
                    if not row or all(not c for c in row):
                        continue

                    if is_footer_row(row):
                        continue

                    # Check if this is a new record (has an index number)
                    index_val = ''
                    if 'index' in col_map and col_map['index'] < len(row):
                        index_val = str(row[col_map['index']] or '').strip()

                    has_index = bool(re.match(r'^\d+$', index_val))

                    # Get cell values
                    def get_cell(col_name: str) -> str:
                        if col_name not in col_map:
                            return ''
                        idx = col_map[col_name]
                        if idx >= len(row):
                            return ''
                        return str(row[idx] or '').strip()

                    name_val = get_cell('name')
                    expiry_val = get_cell('expiry')
                    unit_val = get_cell('unit')
                    qty_val = get_cell('quantity')
                    price_val = get_cell('price')
                    total_val = get_cell('total')
                    code_val = get_cell('code')

                    # Skip rows where name is purely numeric (likely misidentified)
                    if name_val and re.match(r'^[\d,.\s]+$', name_val):
                        name_val = ''

                    if has_index and name_val:
                        # Save previous record
                        if current_record:
                            results.append(current_record)

                        row_number += 1
                        fixed_name = fix_reversed_arabic(name_val)
                        qty = clean_int(qty_val)
                        # Default qty to 1 when PDF has no quantity column (price lists)
                        if qty == 0 and 'quantity' not in col_map:
                            qty = 1
                        cost = clean_price(price_val)
                        total = clean_price(total_val)
                        unit_info = parse_unit_string(unit_val)
                        generic = extract_generic_name(fixed_name)

                        # Infer cost from total/qty if cost is missing but total exists
                        if cost == 0 and total > 0 and qty > 0:
                            cost = total // qty

                        # Infer total from cost×qty if total is missing
                        if total == 0 and cost > 0 and qty > 0:
                            total = cost * qty

                        # Validation: does qty × cost ≈ total?
                        validation_error = False
                        if qty > 0 and cost > 0 and total > 0:
                            expected = qty * cost
                            if abs(expected - total) > max(1, total * 0.05):
                                # Allow up to 5% discrepancy (discounts, rounding)
                                validation_error = True

                        current_record = {
                            'row_number': row_number,
                            'name': fixed_name,
                            'generic_name': generic,
                            'code': code_val,
                            'expiry_date': convert_date(expiry_val),
                            'parent_unit': unit_info['parent_unit'],
                            'child_unit': unit_info['child_unit'],
                            'conversion_factor': unit_info['conversion_factor'],
                            'quantity': qty,
                            'cost_per_parent': cost,
                            'line_total': total,
                            'validation_error': validation_error,
                        }

                    elif not has_index and name_val and current_record:
                        # Continuation line — append to current record's name
                        current_record['name'] += ' ' + fix_reversed_arabic(name_val)
                        # Re-extract generic name from combined text
                        generic = extract_generic_name(current_record['name'])
                        if generic:
                            current_record['generic_name'] = generic

                    elif has_index and not name_val:
                        # Row has index but no name — try to salvage if price exists
                        cost = clean_price(price_val)
                        if cost > 0 and current_record:
                            # Might be a continuation with just price data
                            pass
                        # Otherwise skip this row

                # Don't forget the last record on this page's table
                if current_record:
                    results.append(current_record)
                    current_record = None

    # ── Fallback: word-based extraction if table parsing found nothing ──
    if not results:
        results = _extract_via_words(pdf_path)

    return results


# ─── Entry point ─────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 2:
        sys.stderr.write('Usage: pdf_invoice_parser.py <pdf-file-path>\n')
        sys.exit(1)

    pdf_path = sys.argv[1]

    if not os.path.isfile(pdf_path):
        sys.stderr.write(f'File not found: {pdf_path}\n')
        sys.exit(1)

    try:
        rows = extract_rows(pdf_path)
    except Exception as e:
        sys.stderr.write(f'PDF parsing error: {e}\n')
        sys.exit(1)

    # Output JSON to stdout
    if sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
        try:
            sys.stdout.reconfigure(encoding='utf-8')
        except AttributeError:
            pass  # Python < 3.7

    json.dump(rows, sys.stdout, ensure_ascii=False, indent=None)
    sys.stdout.write('\n')


if __name__ == '__main__':
    main()
