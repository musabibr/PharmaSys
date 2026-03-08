@echo off
REM Build the PDF invoice parser as a standalone exe using PyInstaller.
REM Run from the project root:  scripts\build_pdf_parser.bat

echo Installing dependencies...
pip install pdfplumber pyinstaller

echo Building exe...
pyinstaller --onefile --name pdf_invoice_parser scripts\pdf_invoice_parser.py

echo Copying to build directory...
if not exist build mkdir build
copy /Y dist\pdf_invoice_parser.exe build\pdf_invoice_parser.exe

echo Done! Output: build\pdf_invoice_parser.exe
