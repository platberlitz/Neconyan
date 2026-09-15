[CmdletBinding()]
param(
    [switch]$RequireGit,
    [switch]$RequireBun = $true
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Test-Command {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Add-ToPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Candidate
    )

    if ([string]::IsNullOrWhiteSpace($Candidate) -or -not (Test-Path $Candidate)) {
        return
    }

    $entries = $env:Path -split ';'
    if ($entries -contains $Candidate) {
        return
    }

    $env:Path = "$Candidate;$env:Path"
}

function Refresh-KnownCommandPaths {
    Add-ToPath (Join-Path $env:USERPROFILE '.bun\bin')

    if ($env:ProgramFiles) {
        Add-ToPath (Join-Path $env:ProgramFiles 'Git\cmd')
    }

    $programFilesX86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
    if ($programFilesX86) {
        Add-ToPath (Join-Path $programFilesX86 'Git\cmd')
    }

    if ($env:LocalAppData) {
        Add-ToPath (Join-Path $env:LocalAppData 'Programs\Git\cmd')
    }
}

function Install-Bun {
    if (Test-Command 'bun') {
        return
    }

    Write-Host 'Bun was not found. Installing it automatically...'
    Invoke-Expression (Invoke-RestMethod -Uri 'https://bun.sh/install.ps1')
    Refresh-KnownCommandPaths

    if (-not (Test-Command 'bun')) {
        throw 'Bun installation finished, but `bun` is still unavailable in this session.'
    }
}

function Install-Git {
    if (Test-Command 'git') {
        return
    }

    Write-Host 'Git was not found. Installing it automatically...'

    if (Test-Command 'winget') {
        & winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements
    } elseif (Test-Command 'choco') {
        & choco install git -y
    } elseif (Test-Command 'scoop') {
        & scoop install git
    } else {
        throw 'Automatic Git installation requires winget, Chocolatey, or Scoop. Install Git manually from https://git-scm.com/downloads'
    }

    if ($LASTEXITCODE -ne 0) {
        throw 'Automatic Git installation failed.'
    }

    Refresh-KnownCommandPaths

    if (-not (Test-Command 'git')) {
        throw 'Git installation finished, but `git` is still unavailable in this session.'
    }
}

Refresh-KnownCommandPaths

if ($RequireGit) {
    Install-Git
}

if ($RequireBun) {
    Install-Bun
}

Write-Host 'All requested prerequisites are available.'
