# Spin up Windows Container on a Windows Host in GitHub Actions

This actions provides the scaffolding to use Windows containers in GitHub
Actions with automatic cleanup. Requires a Windows host with Docker installed
and configured to run Windows containers. This action also assumes that it can
run `docker pull`, `docker run`, and `docker rm` commands as is. Check
permissions accordingly and ensure that the Docker CLI is available in the
PATH.[^1]

## Inputs

### `image`

**Required** The name of the Windows container image to use. This can be a local
image or an image from a registry. This action does not attempt any
authentication, so if the image is private, ensure that the host is already
authenticated to the registry.

## Outputs

### `container_id`

The ID of the container that was created. This can be used in subsequent steps
to interact with the container, such as running commands or copying files. The
container will be automatically cleaned up at the end of the job, so there is no
need to worry about manual cleanup.

Note: for hyper-v isolation, docker cp will not work. Instead,
`${GITHUB_WORKSPACE}` is mounted into the container at `C:\workspace`, so you
can instead copy files to the workspace and access them from within the
container at that location.

## Example usage

<!-- prettier-ignore -->
```yml
jobs:
  test-action:
    runs-on: windows-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v6
        with:
          persist-credentials: false
          repository: moby/docker-ci-zap

      - name: Spin up Windows container
        uses: ./
        with:
          image: golang:windowsservercore-ltsc2025

      - name: Build the Go application in the container
        shell: powershell-in-container {0}
        env:
          GOARCH: amd64
          GOOS: windows
        run: |
          Write-Output "Building the Go application inside the container on ${env:GOOS}/${env:GOARCH}..."
          go mod init github.com/moby/docker-ci-zap/zap
          go mod tidy
          go build -o docker-ci-zap.exe zap.go
```

<!-- prettier-ignore-end -->

[^1]:
    Check
    [Docker Desktop Windows permission requirements](https://docs.docker.com/desktop/setup/install/windows-permission-requirements/)
    for more information
