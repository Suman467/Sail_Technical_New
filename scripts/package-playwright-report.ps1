$ErrorActionPreference = 'Stop'

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$reportsDirectory = Join-Path $projectRoot 'reports'
$validationReportDirectory = Join-Path $reportsDirectory 'validation'
$auditReportDirectory = Join-Path $reportsDirectory 'audit'
$technicalReportDirectory = Join-Path $validationReportDirectory 'playwright-html'
$specificationDirectory = Join-Path $projectRoot 'tests'
$zipPath = Join-Path $validationReportDirectory 'Playwright-Reports.zip'
$previousZipPath = Join-Path $validationReportDirectory 'Playwright-HTML-Report.zip'
$temporaryZipPath = "$zipPath.$PID.$([Guid]::NewGuid().ToString('N')).tmp"
$zipReplaceAttempts = 3
$zipReplaceRetryMilliseconds = 300

function Invoke-ZipFileOperationWithRetry {
    param(
        [Parameter(Mandatory = $true)] [scriptblock] $Operation,
        [Parameter(Mandatory = $true)] [string] $Description
    )

    for ($attempt = 1; $attempt -le $zipReplaceAttempts; $attempt++) {
        try {
            & $Operation | Out-Null
            return $true
        }
        catch [System.IO.IOException] {
            if ($attempt -eq $zipReplaceAttempts) {
                Write-Warning "$Description could not complete because the ZIP file remained locked after $zipReplaceAttempts attempts. Report packaging was skipped. $($_.Exception.Message)"
                return $false
            }
            Start-Sleep -Milliseconds $zipReplaceRetryMilliseconds
        }
        catch [System.UnauthorizedAccessException] {
            if ($attempt -eq $zipReplaceAttempts) {
                Write-Warning "$Description could not complete because the ZIP file remained unavailable after $zipReplaceAttempts attempts. Report packaging was skipped. $($_.Exception.Message)"
                return $false
            }
            Start-Sleep -Milliseconds $zipReplaceRetryMilliseconds
        }
    }

    return $false
}

if (-not (Test-Path -LiteralPath $technicalReportDirectory -PathType Container)) {
    throw 'The Playwright HTML report directory was not found.'
}

# Derive eligible custom report names from the specs so stale or timestamped HTML files are excluded.
$specReportNames = @{}
Get-ChildItem -LiteralPath $specificationDirectory -Recurse -File -Filter '*.spec.ts' | ForEach-Object {
    $reportName = $_.Name -replace '\.spec\.ts$', '.html'
    $specReportNames[$reportName] = $true
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::Open($temporaryZipPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    @(
        @{ Directory = $validationReportDirectory; ArchiveFolder = 'validation' },
        @{ Directory = $auditReportDirectory; ArchiveFolder = 'audit' }
    ) | Where-Object { Test-Path -LiteralPath $_.Directory -PathType Container } | ForEach-Object {
        $reportGroup = $_
        Get-ChildItem -LiteralPath $reportGroup.Directory -Recurse -File -Filter '*.html' |
            Where-Object { $specReportNames.ContainsKey($_.Name) } |
            ForEach-Object {
                $relativeReportPath = $_.FullName.Substring($reportGroup.Directory.Length).TrimStart([char[]]@('\', '/')).Replace('\', '/')
                [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                    $archive,
                    $_.FullName,
                    "$($reportGroup.ArchiveFolder)/$relativeReportPath",
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

$packagePublished = Invoke-ZipFileOperationWithRetry -Description "Replacing $zipPath" -Operation {
    Move-Item -LiteralPath $temporaryZipPath -Destination $zipPath -Force
}

if (-not $packagePublished) {
    Remove-Item -LiteralPath $temporaryZipPath -Force -ErrorAction SilentlyContinue
    Write-Warning "Validation and cleanup reports were generated successfully, but $zipPath was not updated. Close any program using the ZIP and run npm run report:package to retry packaging."
    exit 0
}

# Remove the previous archive name after the replacement package was created successfully.
if (Test-Path -LiteralPath $previousZipPath) {
    $previousPackageRemoved = Invoke-ZipFileOperationWithRetry -Description "Removing legacy report package $previousZipPath" -Operation {
        Remove-Item -LiteralPath $previousZipPath -Force
    }
    if (-not $previousPackageRemoved) {
        Write-Warning "The new report package was created, but the locked legacy package could not be removed."
    }
}

Write-Output "Created $zipPath"
