param(
  [Parameter(Mandatory = $true)][string]$FilePath,
  [switch]$AuthenticodeOnly
)

# Read-only: no certificate import, signing, policy changes, or target execution.
# SignedCms verifies CMS mathematics; WinTrust/Get-AuthenticodeSignature and
# SignTool in signature-evidence.mjs verify the PE digest and Windows trust.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$result = [ordered]@{
  status = 'Unavailable'; signerSubject = $null; signerPublisher = $null; signerThumbprint = $null
  publicKeyOID = $null; certificateSignatureOID = $null; timestampPresent = $false
  isPE = $false; signatures = @(); parseErrors = @()
}

function Read-Node([byte[]]$Data, [int]$Offset, [int]$Limit) {
  if ($Offset -lt 0 -or $Limit -gt $Data.Length -or $Offset + 2 -gt $Limit) { throw 'ASN1_BOUNDS' }
  $tag = [int]$Data[$Offset]; $cursor = $Offset + 1
  if (($tag -band 31) -eq 31) { throw 'ASN1_TAG' }
  [long]$length = $Data[$cursor]; $cursor++
  if (($length -band 128) -ne 0) {
    $count = $length -band 127
    if ($count -lt 1 -or $count -gt 4 -or $cursor + $count -gt $Limit) { throw 'ASN1_LENGTH' }
    $length = 0
    for ($i = 0; $i -lt $count; $i++) { $length = ($length * 256) + $Data[$cursor]; $cursor++ }
  }
  if ($length -gt 33554432 -or $cursor + $length -gt $Limit) { throw 'ASN1_BOUNDS' }
  [pscustomobject]@{ Tag = $tag; Offset = $cursor; Length = [int]$length; End = [int]($cursor + $length) }
}
function Read-Children([byte[]]$Data, $Node) {
  $cursor = $Node.Offset; $count = 0
  while ($cursor -lt $Node.End) {
    if (++$count -gt 4096) { throw 'ASN1_COUNT' }
    $child = Read-Node $Data $cursor $Node.End
    $child; $cursor = $child.End
  }
}
function Node-Bytes([byte[]]$Data, $Node) {
  $bytes = New-Object byte[] $Node.Length
  [Array]::Copy($Data, $Node.Offset, $bytes, 0, $Node.Length)
  return ,$bytes
}
function Read-OID([byte[]]$Data, $Node) {
  if ($Node.Tag -ne 6 -or $Node.Length -eq 0) { throw 'ASN1_OID' }
  $parts = New-Object 'System.Collections.Generic.List[string]'
  [long]$value = 0; $first = $true
  for ($i = $Node.Offset; $i -lt $Node.End; $i++) {
    if ($value -gt 72057594037927935) { throw 'ASN1_OID' }
    $value = $value * 128 + ($Data[$i] -band 127)
    if (($Data[$i] -band 128) -eq 0) {
      if ($first) {
        if ($value -lt 40) { $parts.Add('0'); $parts.Add([string]$value) }
        elseif ($value -lt 80) { $parts.Add('1'); $parts.Add([string]($value - 40)) }
        else { $parts.Add('2'); $parts.Add([string]($value - 80)) }
        $first = $false
      } else { $parts.Add([string]$value) }
      $value = 0
    }
  }
  if (($Data[$Node.End - 1] -band 128) -ne 0) { throw 'ASN1_OID' }
  return ($parts -join '.')
}
function Sequence-Fields([byte[]]$Data) {
  $node = Read-Node $Data 0 $Data.Length
  if ($node.Tag -ne 48 -or $node.End -ne $Data.Length) { throw 'ASN1_SEQUENCE' }
  return @(Read-Children $Data $node)
}
function Read-Algorithm([byte[]]$Data, $Node) {
  if ($Node.Tag -ne 48) { throw 'ASN1_ALGORITHM' }
  $fields = @(Read-Children $Data $Node)
  if ($fields.Count -lt 1) { throw 'ASN1_ALGORITHM' }
  return Read-OID $Data $fields[0]
}
function Get-HashBytes([string]$OID, [byte[]]$Bytes) {
  $hash = switch ($OID) {
    '1.3.14.3.2.26' { [Security.Cryptography.SHA1]::Create() }
    '2.16.840.1.101.3.4.2.1' { [Security.Cryptography.SHA256]::Create() }
    '2.16.840.1.101.3.4.2.2' { [Security.Cryptography.SHA384]::Create() }
    '2.16.840.1.101.3.4.2.3' { [Security.Cryptography.SHA512]::Create() }
    default { throw 'TIMESTAMP_DIGEST_UNSUPPORTED' }
  }
  try { return ,$hash.ComputeHash($Bytes) } finally { $hash.Dispose() }
}
function Read-Timestamp([byte[]]$Bytes, $ParentSigner) {
  $token = New-Object Security.Cryptography.Pkcs.SignedCms
  $token.Decode($Bytes)
  if ($token.ContentInfo.ContentType.Value -ne '1.2.840.113549.1.9.16.1.4') { throw 'TIMESTAMP_CONTENT' }
  [byte[]]$content = $token.ContentInfo.Content
  $fields = @(Sequence-Fields $content)
  if ($fields.Count -lt 5 -or $fields[2].Tag -ne 48 -or $fields[4].Tag -ne 24) { throw 'TIMESTAMP_STRUCTURE' }
  $imprint = @(Read-Children $content $fields[2])
  if ($imprint.Count -ne 2 -or $imprint[1].Tag -ne 4) { throw 'TIMESTAMP_IMPRINT' }
  $digestOID = Read-Algorithm $content $imprint[0]
  [byte[]]$actual = Get-HashBytes $digestOID $ParentSigner.GetSignature()
  [byte[]]$expected = Node-Bytes $content $imprint[1]
  $bound = ([Convert]::ToBase64String($actual) -ceq [Convert]::ToBase64String($expected))
  $valid = $false
  try { $token.CheckSignature($true); $valid = ($token.SignerInfos.Count -gt 0) } catch { $valid = $false }
  $genTime = [Text.Encoding]::ASCII.GetString((Node-Bytes $content $fields[4]))
  $at = [DateTime]::MinValue
  $formats = [string[]]@("yyyyMMddHHmmss'Z'", "yyyyMMddHHmmss.FFFFFFF'Z'")
  $dateValid = [DateTime]::TryParseExact($genTime, $formats, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal, [ref]$at)
  $trusted = $valid -and $dateValid -and $at -le [DateTime]::UtcNow.AddMinutes(5)
  if ($trusted) {
    foreach ($tsaSigner in $token.SignerInfos) {
      $chain = New-Object Security.Cryptography.X509Certificates.X509Chain
      try {
        $chain.ChainPolicy.ExtraStore.AddRange($token.Certificates)
        $null = $chain.ChainPolicy.ApplicationPolicy.Add((New-Object Security.Cryptography.Oid('1.3.6.1.5.5.7.3.8')))
        $chain.ChainPolicy.RevocationMode = [Security.Cryptography.X509Certificates.X509RevocationMode]::Online
        $chain.ChainPolicy.RevocationFlag = [Security.Cryptography.X509Certificates.X509RevocationFlag]::ExcludeRoot
        $chain.ChainPolicy.VerificationFlags = [Security.Cryptography.X509Certificates.X509VerificationFlags]::NoFlag
        $chain.ChainPolicy.VerificationTime = $at
        $chain.ChainPolicy.UrlRetrievalTimeout = [TimeSpan]::FromSeconds(5)
        if (-not $tsaSigner.Certificate -or -not $chain.Build($tsaSigner.Certificate)) { $trusted = $false }
      } finally { $chain.Dispose() }
    }
  }
  [pscustomobject]@{
    type = 'RFC3161'; digestOID = $digestOID; signatureValid = $valid; imprintMatches = $bound
    chainValid = $trusted; genTime = $genTime
    signerDigestOIDs = @($token.SignerInfos | ForEach-Object { $_.DigestAlgorithm.Value })
    signerThumbprints = @($token.SignerInfos | ForEach-Object { if ($_.Certificate) { $_.Certificate.Thumbprint } })
  }
}
$script:signatureCount = 0
function Read-Cms([byte[]]$Bytes, [int]$Depth) {
  if ($Depth -gt 4) { throw 'CMS_LIMIT' }
  $cms = New-Object Security.Cryptography.Pkcs.SignedCms
  $cms.Decode($Bytes)
  if ($cms.ContentInfo.ContentType.Value -ne '1.3.6.1.4.1.311.2.1.4') { throw 'CMS_CONTENT' }
  [byte[]]$content = $cms.ContentInfo.Content
  $fields = @(Sequence-Fields $content)
  if ($fields.Count -ne 2 -or $fields[1].Tag -ne 48) { throw 'INDIRECT_DATA' }
  $digestInfo = @(Read-Children $content $fields[1])
  if ($digestInfo.Count -ne 2 -or $digestInfo[1].Tag -ne 4) { throw 'INDIRECT_DIGEST' }
  $fileDigest = Read-Algorithm $content $digestInfo[0]
  if ($cms.SignerInfos.Count -lt 1 -or $cms.SignerInfos.Count -gt 16) { throw 'CMS_SIGNERS' }
  foreach ($signer in $cms.SignerInfos) {
    if (++$script:signatureCount -gt 64) { throw 'CMS_LIMIT' }
    $valid = $false
    try { $signer.CheckSignature($cms.Certificates, $true); $valid = $true } catch { $valid = $false }
    $timestamps = @(); $errors = @(); $nested = @()
    foreach ($attribute in $signer.UnsignedAttributes) {
      if ($attribute.Oid.Value -eq '1.3.6.1.4.1.311.3.3.1') {
        foreach ($value in $attribute.Values) {
          try { $timestamps += Read-Timestamp $value.RawData $signer } catch { $errors += 'RFC3161_PARSE_FAILED' }
        }
      }
      if ($attribute.Oid.Value -eq '1.3.6.1.4.1.311.2.4.1') {
        foreach ($value in $attribute.Values) { $nested += ,$value.RawData }
      }
    }
    foreach ($counter in $signer.CounterSignerInfos) {
      $counterValid = $false
      try { $counter.CheckSignature($cms.Certificates, $true); $counterValid = $true } catch { $counterValid = $false }
      $timestamps += [pscustomobject]@{
        type = 'Authenticode'; digestOID = $counter.DigestAlgorithm.Value
        signatureValid = $counterValid; imprintMatches = $counterValid
        signerThumbprints = @($(if ($counter.Certificate) { $counter.Certificate.Thumbprint }))
      }
    }
    [pscustomobject]@{
      fileDigestOID = $fileDigest; signatureDigestOID = $signer.DigestAlgorithm.Value
      publicKeyOID = $(if ($signer.Certificate) { $signer.Certificate.PublicKey.Oid.Value } else { $null })
      certificateSignatureOID = $(if ($signer.Certificate) { $signer.Certificate.SignatureAlgorithm.Value } else { $null })
      signerSubject = $(if ($signer.Certificate) { $signer.Certificate.Subject } else { $null })
      signerThumbprint = $(if ($signer.Certificate) { $signer.Certificate.Thumbprint } else { $null })
      signatureValid = $valid; timestamps = @($timestamps); parseErrors = @($errors); nestedDepth = $Depth
    }
    foreach ($item in $nested) { Read-Cms $item ($Depth + 1) }
  }
}

try {
  $fullPath = [IO.Path]::GetFullPath($FilePath)
  $auth = Get-AuthenticodeSignature -LiteralPath $fullPath
  $result.status = [string]$auth.Status
  if ($auth.SignerCertificate) {
    $result.signerSubject = $auth.SignerCertificate.Subject
    $result.signerPublisher = $auth.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
    $result.signerThumbprint = $auth.SignerCertificate.Thumbprint
    $result.publicKeyOID = $auth.SignerCertificate.PublicKey.Oid.Value
    $result.certificateSignatureOID = $auth.SignerCertificate.SignatureAlgorithm.Value
  }
  $result.timestampPresent = ($null -ne $auth.TimeStamperCertificate)
  if (-not $AuthenticodeOnly) {
    Add-Type -AssemblyName System.Security
    $stream = [IO.File]::Open($fullPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $reader = New-Object IO.BinaryReader($stream)
    try {
      if ($stream.Length -lt 64 -or $reader.ReadUInt16() -ne 0x5A4D) { throw 'NOT_PE' }
      $stream.Position = 60; [long]$pe = $reader.ReadUInt32()
      if ($pe -lt 64 -or $pe + 24 -gt $stream.Length) { throw 'PE_HEADER_BOUNDS' }
      $stream.Position = $pe
      if ($reader.ReadUInt32() -ne 0x00004550) { throw 'NOT_PE' }
      $stream.Position = $pe + 20; $optionalLength = $reader.ReadUInt16()
      $optional = $pe + 24
      if ($optional + $optionalLength -gt $stream.Length) { throw 'PE_OPTIONAL_BOUNDS' }
      $stream.Position = $optional; $magic = $reader.ReadUInt16()
      if ($magic -eq 0x10B) { $directoryOffset = 96 }
      elseif ($magic -eq 0x20B) { $directoryOffset = 112 }
      else { throw 'PE_OPTIONAL_MAGIC' }
      if ($optionalLength -lt $directoryOffset + 40) { throw 'PE_DIRECTORY_BOUNDS' }
      $result.isPE = $true
      $stream.Position = $optional + $directoryOffset - 4
      if ($reader.ReadUInt32() -lt 5) { throw 'PE_NO_CERT_DIRECTORY' }
      $stream.Position = $optional + $directoryOffset + 32
      [long]$certificateOffset = $reader.ReadUInt32(); [long]$certificateLength = $reader.ReadUInt32()
      if ($certificateOffset -eq 0 -and $certificateLength -eq 0) { $result.signatures = @() }
      else {
        if (($certificateOffset % 8) -ne 0 -or $certificateOffset -lt $optional + $optionalLength -or $certificateLength -gt 33554432 -or $certificateLength -lt 8 -or $certificateOffset + $certificateLength -gt $stream.Length) { throw 'PE_CERT_BOUNDS' }
        $end = $certificateOffset + $certificateLength; $cursor = $certificateOffset; $count = 0
        while ($cursor -lt $end) {
          if (++$count -gt 64 -or $cursor + 8 -gt $end) { throw 'PE_CERT_COUNT' }
          $stream.Position = $cursor; [long]$length = $reader.ReadUInt32()
          $revision = $reader.ReadUInt16(); $type = $reader.ReadUInt16()
          if ($length -lt 8 -or $cursor + $length -gt $end -or $revision -ne 0x200 -or $type -ne 2) { throw 'PE_CERT_FORMAT' }
          [byte[]]$cmsBytes = $reader.ReadBytes([int]($length - 8))
          $result.signatures += @(Read-Cms $cmsBytes 0)
          $cursor += [long]([Math]::Ceiling($length / 8.0) * 8)
          if ($cursor -gt $end) { throw 'PE_CERT_ALIGNMENT' }
        }
      }
    } finally { $reader.Dispose(); $stream.Dispose() }
  }
} catch {
  # Do not serialize arbitrary exception text, environment, or certificate private data.
  $code = [string]$_.Exception.Message
  if ($code -notmatch '^(NOT_PE|ASN1_[A-Z_]+|PE_[A-Z_]+|CMS_[A-Z_]+|INDIRECT_[A-Z_]+|TIMESTAMP_[A-Z_]+)$') { $code = 'SIGNATURE_READ_FAILED' }
  $result.parseErrors += $code
}
[pscustomobject]$result | ConvertTo-Json -Depth 12 -Compress
