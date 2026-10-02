param(
  [string]$AppDirectory = (Join-Path $PSScriptRoot '../release/win-unpacked'),
  [string]$InstallerPath = (Join-Path $PSScriptRoot '../release/Design Studio Setup 0.1.0.exe'),
  [string]$ReportPath,
  [string]$FilesJsonPath,
  [switch]$InventoryOnly
)

# Read-only signature inventory. Never imports certificates or changes policy.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$appRoot = [IO.Path]::GetFullPath($AppDirectory)
if ($FilesJsonPath) {
  $request = Get-Content -LiteralPath $FilesJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $requested = @($request.files)
  if (-not $requested.Count) { throw 'No executable files were supplied.' }
  $files = @(foreach ($name in $requested) { Get-Item -LiteralPath ([IO.Path]::GetFullPath([string]$name)) })
} else {
  if (-not (Test-Path -LiteralPath $appRoot -PathType Container)) {
    throw 'Windows app directory does not exist.'
  }
  $files = @(Get-ChildItem -LiteralPath $appRoot -File -Recurse | Where-Object { $_.Extension.ToLowerInvariant() -in @('.exe', '.dll', '.node') })
}
if (-not $FilesJsonPath -and $InstallerPath) {
  $installer = [IO.Path]::GetFullPath($InstallerPath)
  if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw 'Installer does not exist.' }
  $files += Get-Item -LiteralPath $installer
}
$results = @(foreach ($file in $files) {
  $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
  $hash = Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256
  [pscustomobject]@{
    Path = $file.FullName
    Size = $file.Length
    SHA256 = $hash.Hash.ToLowerInvariant()
    Status = [string]$signature.Status
    Signer = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null }
    SignerThumbprint = if ($signature.SignerCertificate) { $signature.SignerCertificate.Thumbprint } else { $null }
    PublicKeyAlgorithm = if ($signature.SignerCertificate) { $signature.SignerCertificate.PublicKey.Oid.Value } else { $null }
    TimestampPresent = ($null -ne $signature.TimeStamperCertificate)
  }
})
$invalid = @($results | Where-Object { $_.Status -ne 'Valid' })
$nonRsa = @($results | Where-Object { $_.Status -eq 'Valid' -and $_.PublicKeyAlgorithm -ne '1.2.840.113549.1.1.1' })
$report = [pscustomobject]@{
  CheckedAt = [DateTime]::UtcNow.ToString('o')
  AppDirectory = $appRoot
  PolicyChanged = $false
  FileCount = $results.Count
  InvalidCount = $invalid.Count
  NonRsaCount = $nonRsa.Count
  Passed = ($results.Count -gt 0 -and $invalid.Count -eq 0 -and $nonRsa.Count -eq 0)
  Note = 'Authenticode trust alone does not certify Smart App Control acceptance; launch and every feature must still be tested under enforcement.'
  Files = $results
}
if ($ReportPath) {
  $destination = [IO.Path]::GetFullPath($ReportPath)
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) | Out-Null
  $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $destination -Encoding utf8
}
[pscustomobject]@{FileCount=$report.FileCount; InvalidCount=$report.InvalidCount; NonRsaCount=$report.NonRsaCount; Passed=$report.Passed; ReportPath=$ReportPath} | ConvertTo-Json
if (-not $InventoryOnly -and -not $report.Passed) { exit 2 }
