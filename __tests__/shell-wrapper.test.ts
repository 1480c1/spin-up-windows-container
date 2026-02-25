type ShellWrapperModule = typeof import('../src/shell-wrapper.js')

let shellWrapper: ShellWrapperModule

beforeAll(async () => {
    shellWrapper = await import('../src/shell-wrapper.js')
})

describe('shell-wrapper', () => {
    test('builds a wrapper script with expected docker exec command and CRLF line endings', () => {
        const script = shellWrapper.wrapper(
            shellWrapper.Shell.powershell,
            'container-123',
            shellWrapper.CONTAINER_WORKSPACE
        )

        expect(script).toContain('\r\n')
        expect(script).toContain(
            'docker exec -i -w "C:\\workspace" --env-file "%ENV_FILE%" "container-123"'
        )
        expect(script).toContain('echo GITHUB_WORKSPACE=C:\\workspace >> "%ENV_FILE%"')
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
            shellWrapper.CONTAINER_WORKSPACE
        )

        expect(script).toContain(
            '"%ComSpec%" /D /E:ON /V:OFF /S /C ""CALL "C:\\workspace\\%~nx1.cmd"""'
        )
    })
})
