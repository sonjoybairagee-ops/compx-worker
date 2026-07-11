# rebuild-plugins.ps1
# এই script সব plugin folder-এ গিয়ে scraper-core রিফ্রেশ করে build চালাবে
# এবং শেষে একটা সামারি দেখাবে কোনটা সফল হলো আর কোনটায় error এলো।

$workerRoot = "D:\app\compx leads pro\worker"
$pluginsDir = Join-Path $workerRoot "src\plugins"

# আপনার সব plugin-এর নাম এখানে লিস্ট করা আছে
$plugins = @(
    "facebook",
    "google-maps",
    "website",
    "amazon",
    "ebay",
    "instagram",
    "linkedin",
    "tripadvisor",
    "youtube"
)

$results = @()

foreach ($plugin in $plugins) {
    $pluginPath = Join-Path $pluginsDir $plugin

    Write-Host ""
    Write-Host "=======================================" -ForegroundColor Cyan
    Write-Host " Processing: $plugin" -ForegroundColor Cyan
    Write-Host "=======================================" -ForegroundColor Cyan

    if (-not (Test-Path $pluginPath)) {
        Write-Host "  SKIP: folder not found -> $pluginPath" -ForegroundColor Yellow
        $results += [PSCustomObject]@{ Plugin = $plugin; Status = "SKIPPED (folder not found)" }
        continue
    }

    Push-Location $pluginPath

    # ১. পুরনো stale scraper-core মুছে ফেলা
    $scraperCorePath = Join-Path $pluginPath "node_modules\@compx\scraper-core"
    if (Test-Path $scraperCorePath) {
        Remove-Item -Recurse -Force $scraperCorePath -ErrorAction SilentlyContinue
    }

    # ২. npm install
    Write-Host "  Running npm install..." -ForegroundColor Gray
    npm install *> "$env:TEMP\npm-install-$plugin.log"
    $installExitCode = $LASTEXITCODE

    if ($installExitCode -ne 0) {
        Write-Host "  FAILED at npm install (exit $installExitCode)" -ForegroundColor Red
        Write-Host "  Log: $env:TEMP\npm-install-$plugin.log" -ForegroundColor Red
        $results += [PSCustomObject]@{ Plugin = $plugin; Status = "FAILED (npm install)" }
        Pop-Location
        continue
    }

    # ৩. npm run build
    Write-Host "  Running npm run build..." -ForegroundColor Gray
    npm run build *> "$env:TEMP\npm-build-$plugin.log"
    $buildExitCode = $LASTEXITCODE

    if ($buildExitCode -ne 0) {
        Write-Host "  FAILED at npm run build (exit $buildExitCode)" -ForegroundColor Red
        Write-Host "  Log: $env:TEMP\npm-build-$plugin.log" -ForegroundColor Red
        $results += [PSCustomObject]@{ Plugin = $plugin; Status = "FAILED (npm run build)" }
        Pop-Location
        continue
    }

    Write-Host "  SUCCESS" -ForegroundColor Green
    $results += [PSCustomObject]@{ Plugin = $plugin; Status = "SUCCESS" }

    Pop-Location
}

Write-Host ""
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host " SUMMARY" -ForegroundColor Cyan
Write-Host "=======================================" -ForegroundColor Cyan
$results | Format-Table -AutoSize

$failed = $results | Where-Object { $_.Status -like "FAILED*" }
if ($failed) {
    Write-Host ""
    Write-Host "কিছু plugin fail করেছে। উপরে দেওয়া log file path থেকে বিস্তারিত error দেখুন।" -ForegroundColor Yellow
} else {
    Write-Host ""
    Write-Host "সব plugin সফলভাবে build হয়েছে!" -ForegroundColor Green
}
