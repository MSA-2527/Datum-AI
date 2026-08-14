<#
.SYNOPSIS
    Authenticode-signs the DATUM installer and binaries.

.DESCRIPTION
    Production builds sign with an EV code-signing certificate held in a hardware token or
    an HSM-backed cloud signing service. That certificate is deliberately NOT in this
    repository and never will be: a signing key in source control is a supply-chain
    incident waiting to happen.

    For local verification the script can generate a self-signed test certificate. That
    proves the pipeline works end to end, but such a signature means nothing to a customer
    machine - SmartScreen will still warn, because the certificate chains to nothing
    anyone trusts. Never ship a test-signed build.

    This file is pure ASCII on purpose; Windows PowerShell 5.1 reads .ps1 as ANSI and a
    stray non-ASCII character breaks its parser before the script runs.

.PARAMETER TestCertificate
    Generate and use a self-signed certificate instead of looking for a real one.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File installers\sign.ps1 -TestCertificate
#>
[CmdletBinding()]
param(
    [string]$Path = 'dist\DATUM.msi',
    [string]$Thumbprint,
    [switch]$TestCertificate,
    [string]$TimestampUrl = 'http://timestamp.digicert.com'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

if (-not (Test-Path $Path)) {
    throw "$Path not found. Run installers\build.ps1 first."
}

# --- locate a certificate ---------------------------------------------------

$cert = $null

if ($Thumbprint) {
    $cert = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Thumbprint -eq $Thumbprint }
    if (-not $cert) { throw "No certificate with thumbprint $Thumbprint in CurrentUser\My." }
}
elseif ($TestCertificate) {
    Write-Host 'Generating a self-signed TEST certificate...' -ForegroundColor Yellow
    Write-Host '  This proves the pipeline works. It is NOT valid for distribution.' -ForegroundColor Yellow

    $cert = New-SelfSignedCertificate `
        -Type CodeSigningCert `
        -Subject 'CN=DATUM Test Signing (DO NOT DISTRIBUTE)' `
        -CertStoreLocation Cert:\CurrentUser\My `
        -NotAfter (Get-Date).AddDays(30) `
        -KeyUsage DigitalSignature `
        -KeyExportPolicy NonExportable
}
else {
    # Prefer a real code-signing certificate if one happens to be installed.
    $cert = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert |
            Where-Object { $_.NotAfter -gt (Get-Date) } |
            Sort-Object NotAfter -Descending |
            Select-Object -First 1

    if (-not $cert) {
        throw @'
No code-signing certificate found.

Production: install the EV certificate (token or HSM) and pass -Thumbprint.
Local check: re-run with -TestCertificate to verify the pipeline only.
'@
    }
}

Write-Host "Signing with: $($cert.Subject)" -ForegroundColor Cyan

# --- sign -------------------------------------------------------------------

# Timestamping is what keeps a signature valid after the certificate expires. Without it
# every shipped build stops verifying the day the cert lapses.
$signParams = @{
    FilePath      = $Path
    Certificate   = $cert
    HashAlgorithm = 'SHA256'
}

try {
    $result = Set-AuthenticodeSignature @signParams -TimestampServer $TimestampUrl
}
catch {
    Write-Host "Timestamp server unreachable; signing without a timestamp." -ForegroundColor Yellow
    Write-Host "  The signature will stop verifying when the certificate expires." -ForegroundColor Yellow
    $result = Set-AuthenticodeSignature @signParams
}

Write-Host "Status: $($result.Status)" -ForegroundColor $(if ($result.Status -eq 'Valid') { 'Green' } else { 'Yellow' })

# --- verify -----------------------------------------------------------------

$check = Get-AuthenticodeSignature -FilePath $Path

Write-Output ""
Write-Output "Signature:  $($check.Status)"
Write-Output "Signer:     $($check.SignerCertificate.Subject)"
Write-Output "Algorithm:  $($check.SignerCertificate.SignatureAlgorithm.FriendlyName)"
Write-Output "Timestamp:  $(if ($check.TimeStamperCertificate) { 'yes' } else { 'none' })"

# A signature was either applied or it was not; whether Windows TRUSTS it is a separate
# question. A self-signed certificate produces a real, well-formed signature that reports
# UnknownError because the chain terminates at a root nobody trusts - which is exactly
# what a test certificate is supposed to do. Conflating the two would either fail a
# working pipeline or, far worse, pass a build that was never signed at all.
if (-not $check.SignerCertificate) {
    throw "Signing did not produce a signature. The file is unsigned."
}

switch ($check.Status) {
    'Valid' {
        Write-Host "Signature is valid and the certificate chain is trusted." -ForegroundColor Green
    }
    'UnknownError' {
        # Untrusted chain: normal for a test certificate, a defect for a production one.
        if ($TestCertificate) {
            Write-Host "Signature applied. Chain is untrusted, as expected for a test certificate." -ForegroundColor Yellow
        }
        else {
            throw "Signed, but the certificate chain is not trusted. Check that the full chain is installed."
        }
    }
    default {
        throw "Signature verification returned $($check.Status)."
    }
}

if ($TestCertificate) {
    Write-Output ""
    Write-Warning "TEST-SIGNED BUILD. Not valid for distribution. SmartScreen will warn on any customer machine."
}
