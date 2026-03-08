# PharmaSys Code Signing Certificate Generator
# Run this script in PowerShell as Administrator to create a self-signed certificate.
#
# For production, purchase a code signing certificate from DigiCert, Sectigo, or similar.
# Then set these environment variables before running `npm run build:signed`:
#   $env:CSC_LINK = "path/to/certificate.pfx"
#   $env:CSC_KEY_PASSWORD = "your-password"
#
# This script creates a self-signed certificate for development/testing.

param(
    [string]$CertName = "PharmaSys",
    [string]$OutputPath = "build/pharmasys-cert.pfx",
    [string]$Password = "PharmaSys2024!"
)

$ErrorActionPreference = "Stop"

Write-Host "Creating self-signed code signing certificate..." -ForegroundColor Cyan

# Create self-signed certificate
$cert = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject "CN=$CertName, O=PharmaSys, C=SD" `
    -KeyAlgorithm RSA `
    -KeyLength 2048 `
    -HashAlgorithm SHA256 `
    -CertStoreLocation "Cert:\CurrentUser\My" `
    -NotAfter (Get-Date).AddYears(3) `
    -FriendlyName "$CertName Code Signing"

Write-Host "Certificate created: $($cert.Thumbprint)" -ForegroundColor Green

# Export to PFX
$securePwd = ConvertTo-SecureString -String $Password -Force -AsPlainText
$certPath = Resolve-Path $OutputPath -ErrorAction SilentlyContinue
if (-not $certPath) {
    $certPath = $OutputPath
}

Export-PfxCertificate -Cert $cert -FilePath $certPath -Password $securePwd | Out-Null

Write-Host "Certificate exported to: $certPath" -ForegroundColor Green
Write-Host ""
Write-Host "To use for building, set environment variables:" -ForegroundColor Yellow
Write-Host '  $env:CSC_LINK = "build/pharmasys-cert.pfx"' -ForegroundColor White
Write-Host "  `$env:CSC_KEY_PASSWORD = `"$Password`"" -ForegroundColor White
Write-Host ""
Write-Host "Then run: npm run build:signed" -ForegroundColor Yellow
Write-Host ""
Write-Host "NOTE: Self-signed certificates will trigger Windows SmartScreen warnings." -ForegroundColor Red
Write-Host "For production distribution, purchase a certificate from DigiCert/Sectigo." -ForegroundColor Red
