type ShellWrapperModule = typeof import('../src/shell-wrapper.js')

let shellWrapper: ShellWrapperModule

beforeAll(async () => {
    shellWrapper = await import('../src/shell-wrapper.js')
})

describe('shell-wrapper', () => {
    const mockScriptDir = 'C:\\temp\\container-wrapper'

    test('builds a wrapper script with expected docker exec command and CRLF line endings', () => {
        const script = shellWrapper.wrapper(
            shellWrapper.Shell.powershell,
            'container-123',
            shellWrapper.CONTAINER_WORKSPACE,
            mockScriptDir
        )

        expect(script).toContain('\r\n')
        expect(script).toContain(
            'docker exec -i -w "C:\\workspace" --env-file "%ENV_FILE%" "container-123"'
        )
        expect(script).toContain(
            `powershell -NoProfile -ExecutionPolicy Bypass -File "${mockScriptDir}\\${shellWrapper.ENV_SCRIPT_NAME}"`
        )
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
            shellWrapper.Shell.cmd,
            'container-xyz',
            shellWrapper.CONTAINER_WORKSPACE,
            mockScriptDir
        )

        expect(script).toContain('%ComSpec% /D /E:ON /V:OFF /S /C "C:\\workspace\\%~nx1.cmd"')
        expect(script).not.toContain('.cmd\\"')
    })

    test('generates PowerShell environment script with path conversion', () => {
        const script = shellWrapper.env_script()

        expect(script).toContain('\r\n')
        expect(script).toContain('[regex]::Escape($oldPath)')
        expect(script).toContain('GITHUB_WORKSPACE=${container_workspace}')
    })
})
