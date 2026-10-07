$ErrorActionPreference = 'Stop'

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$reportsDirectory = Join-Path $projectRoot 'reports'
$validationReportDirectory = Join-Path $reportsDirectory 'validation'
$auditReportDirectory = Join-Path $reportsDirectory 'audit'
$technicalReportDirectory = Join-Path $validationReportDirectory 'playwright-html'
$specificationDirectory = Join-Path $projectRoot 'tests'
$zipPath = Join-Path $validationReportDirectory 'Playwright-Reports.zip'
$previousZipPath = Join-Path $validationReportDirectory 'Playwright-HTML-Report.zip'

if (-not (Test-Path -LiteralPath $technicalReportDirectory -PathType Container)) {
    throw 'The Playwright HTML report directory was not found.'
}

# Derive eligible custom report names from the specs so stale or timestamped HTML files are excluded.
$specReportNames = @{}
Get-ChildItem -LiteralPath $specificationDirectory -Recurse -File -Filter '*.spec.ts' | ForEach-Object {
    $reportName = $_.Name -replace '\.spec\.ts$', '.html'
    $specReportNames[$reportName] = $true
}

if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    @(
        @{ Directory = $validationReportDirectory; ArchiveFolder = 'validation' },
        @{ Directory = $auditReportDirectory; ArchiveFolder = 'audit' }
    ) | Where-Object { Test-Path -LiteralPath $_.Directory -PathType Container } | ForEach-Object {
        $reportGroup = $_
        Get-ChildItem -LiteralPath $reportGroup.Directory -File -Filter '*.html' |
            Where-Object { $specReportNames.ContainsKey($_.Name) } |
            ForEach-Object {
                [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                    $archive,
                    $_.FullName,
                    "$($reportGroup.ArchiveFolder)/$($_.Name)",
                    [System.IO.Compression.CompressionLevel]::Optimal
                ) | Out-Null
            }
    }

    Get-ChildItem -LiteralPath $technicalReportDirectory -Recurse -File | ForEach-Object {
        $relativePath = $_.FullName.Substring($technicalReportDirectory.Length).TrimStart([char[]]@('\', '/')).Replace('\', '/')
        $entryName = "html/$relativePath"
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $archive,
            $_.FullName,
            $entryName,
            [System.IO.Compression.CompressionLevel]::Optimal
        ) | Out-Null
    }
}
finally {
    $archive.Dispose()
}

# Remove the previous archive name after the replacement package was created successfully.
if (Test-Path -LiteralPath $previousZipPath) {
    Remove-Item -LiteralPath $previousZipPath -Force
}

Write-Output "Created $zipPath"
