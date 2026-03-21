/**
 * Print HTML content via a hidden iframe.
 * Handles RTL direction automatically.
 */
export function printHtml(html: string) {
  const iframe = document.createElement('iframe');
  iframe.style.display = 'none';
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument!;
  const dir = document.documentElement.dir || 'ltr';
  const align = dir === 'rtl' ? 'right' : 'left';
  doc.open();
  doc.write(`<!DOCTYPE html><html dir="${dir}"><head><style>
    body { font-family: 'Noto Kufi Arabic', system-ui, -apple-system, sans-serif; margin: 20px; font-size: ${dir === 'rtl' ? '13px' : '12px'}; ${dir === 'rtl' ? 'line-height: 1.7;' : ''} }
    h2, h3 { margin: 8px 0; }
    table { width: 100%; border-collapse: collapse; margin: 10px 0; }
    th, td { border: 1px solid #ccc; padding: 6px 8px; text-align: ${align}; }
    th { background: #f0f0f0; font-weight: 600; }
    .num { text-align: ${dir === 'rtl' ? 'left' : 'right'}; direction: ltr; unicode-bidi: isolate; }
    .summary { margin: 15px 0; padding: 10px; background: #f9f9f9; border: 1px solid #ddd; }
    .summary p { margin: 4px 0; }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; border-bottom: 2px solid #333; padding-bottom: 10px; }
    .badge { display: inline-block; padding: 2px 6px; border-radius: 3px; font-size: 10px; }
    .badge-red { background: #fee2e2; color: #dc2626; }
    .badge-yellow { background: #fef3c7; color: #d97706; }
    .badge-green { background: #dcfce7; color: #16a34a; }
    @page { size: landscape; margin: 10mm; }
    @media print { body { margin: 0; } }
  </style></head><body>${html}</body></html>`);
  doc.close();
  iframe.contentWindow!.focus();
  iframe.contentWindow!.print();
  setTimeout(() => document.body.removeChild(iframe), 1500);
}
