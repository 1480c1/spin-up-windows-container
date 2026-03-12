type ShellWrapperModule = typeof import('../src/shell-wrapper.js')

let shellWrapper: ShellWrapperModule

beforeAll(async () => {
    shellWrapper = await import('../src/shell-wrapper.js')
})

describe('shell-wrapper', () => {
    const helperScript = 'C:\\action\\dist\\container-exec.js'
    const nodePath = 'C:\\hostedtoolcache\\windows\\node\\24.0.0\\x64\\node.exe'

    test('builds a wrapper script with expected helper command and CRLF line endings', () => {
        const script = shellWrapper.wrapper(
            'powershell',
            shellWrapper.Shell.powershell,
            'container-123',
            shellWrapper.CONTAINER_WORKSPACE,
            helperScript,
            nodePath
        )

        expect(script).toContain('\r\n')
        expect(script).toContain(
            `"${nodePath}" "${helperScript}" --container-id "container-123" --shell-name "powershell"`
        )
        expect(script).toContain('--host-workspace "%GITHUB_WORKSPACE%"')
    })

    test('returns powershell shell info with ps1 suffix and LASTEXITCODE forwarding', () => {
        const [generator, suffix] = shellWrapper.get_shell_info(shellWrapper.Shell.powershell)
        const generated = generator('in-file', 'out-file')

        expect(suffix).toBe('ps1')
        expect(generated).toContain("$ErrorActionPreference = 'stop'")
        expect(generated).toContain('LASTEXITCODE')
    })

    test('uses safely quoted cmd invocation format', () => {
        const script = shellWrapper.wrapper(
            'cmd',
            shellWrapper.Shell.cmd,
            'container-xyz',
            shellWrapper.CONTAINER_WORKSPACE,
            helperScript,
            nodePath
        )

        expect(script).toContain('--shell-name "cmd"')
        expect(script).toContain('--script-path "C:\\workspace\\%~nx1.cmd"')
    })
})
