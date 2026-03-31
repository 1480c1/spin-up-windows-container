import { Writable } from 'node:stream'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { closeDockerClient, createDockerClient, type ActionDockerClient } from './docker-client.js'

type CliArgs = {
    containerId: string
    shellName: string
    scriptPath: string
    hostWorkspace: string
}

function parseArgs(argv: string[]): CliArgs {
    const args = new Map<string, string>()
    for (let i = 0; i < argv.length; i += 2) {
        const key = argv[i]
        const value = argv[i + 1]
        if (!key?.startsWith('--') || value === undefined) {
            throw new Error('Invalid arguments to container-exec helper.')
        }
        args.set(key.slice(2), value)
    }

    const containerId = args.get('container-id')
    const shellName = args.get('shell-name')
    const scriptPath = args.get('script-path')
    const hostWorkspace = args.get('host-workspace')
    if (!containerId || !shellName || !scriptPath || !hostWorkspace) {
        throw new Error('Missing required helper arguments.')
    }

    return {
        containerId,
        shellName,
        scriptPath,
        hostWorkspace
    }
}

function parseEnvLines(envOutput: string): Map<string, string> {
    const env = new Map<string, string>()
    for (const line of envOutput.split(/\r?\n/)) {
        if (!line) {
            continue
        }
        const index = line.indexOf('=')
        if (index <= 0) {
            continue
        }
        const key = line.slice(0, index)
        const value = line.slice(index + 1)
        env.set(key.toUpperCase(), value)
    }
    return env
}

function buildShellCommand(shellName: string, scriptPath: string): string[] {
    switch (shellName) {
        case 'bash':
            return ['bash', '--noprofile', '--norc', '-eo', 'pipefail', scriptPath]
        case 'pwsh':
            return ['pwsh', '-NoLogo', '-Command', `. '${scriptPath}'`]
        case 'python':
            return ['python', scriptPath]
        case 'cmd':
            return ['cmd', '/D', '/E:ON', '/V:OFF', '/S', '/C', scriptPath]
        case 'powershell':
            return ['powershell', '-NoLogo', '-Command', `. '${scriptPath}'`]
        default:
            throw new Error(`Unsupported shell: ${shellName}`)
    }
}

async function getCommandOutput(
    client: ActionDockerClient,
    containerId: string,
    cmd: string[]
): Promise<string> {
    const exec = await client.containerExec(containerId, {
        AttachStdout: true,
        AttachStderr: true,
        Cmd: cmd
    })

    let output = ''
    const capture = new Writable({
        write(chunk, _encoding, callback): void {
            output += chunk.toString()
            callback()
        }
    })

    await client.execStart(exec.Id, capture, capture, { Tty: false, Detach: false })
    return output
}

/** System environment variables that must never be overridden from the host. */
const BLOCKED_VARS = new Set([
    'PATH',
    'PATHEXT',
    'APPDATA',
    'LOCALAPPDATA',
    'PROGRAMDATA',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'COMMONPROGRAMFILES',
    'COMMONPROGRAMFILES(X86)',
    'SYSTEMDRIVE',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'USERNAME',
    'USERDOMAIN',
    'HOMEDRIVE',
    'HOMEPATH',
    'PSMODULEPATH',
    'NUMBER_OF_PROCESSORS',
    'PROCESSOR_ARCHITECTURE',
    'PROCESSOR_IDENTIFIER',
    'PROCESSOR_LEVEL',
    'PROCESSOR_REVISION',
    'OS'
])

/** Prefixes for environment variables that should always be forwarded from the host. */
const OVERRIDE_PREFIXES = ['GITHUB_', 'RUNNER_', 'ACTIONS_']

const DRIVE_LETTER_RE = /^[A-Za-z]:/

export function buildExecEnv(
    hostWorkspace: string,
    containerVars: Map<string, string>
): { env: string[]; containerWorkspace: string } {
    const containerWorkspace = containerVars.get('GITHUB_WORKSPACE') || ''
    const env: string[] = []

    // Extract the host drive letter (e.g. "D") for rewriting.
    const hostDrive = DRIVE_LETTER_RE.test(hostWorkspace) ? hostWorkspace[0] : ''

    for (const [name, value] of Object.entries(process.env)) {
        if (!value) continue

        const upper = name.toUpperCase()

        // Always block system-critical variables.
        if (BLOCKED_VARS.has(upper)) continue

        // For variables already in the container: only forward if they
        // match an override prefix (job-critical vars that may change between steps).
        if (containerVars.has(upper)) {
            const shouldOverride = OVERRIDE_PREFIXES.some((prefix) => upper.startsWith(prefix))
            if (!shouldOverride) continue
        }

        // Rewrite drive letters: D:\ → C:\ and D:/ → C:/
        let rewritten = value
        if (hostDrive) {
            rewritten = rewritten.split(`${hostDrive}:\\`).join('C:\\')
            rewritten = rewritten.split(`${hostDrive}:/`).join('C:/')
            // Also handle lowercase drive letter
            const lowerDrive = hostDrive.toLowerCase()
            rewritten = rewritten.split(`${lowerDrive}:\\`).join('C:\\')
            rewritten = rewritten.split(`${lowerDrive}:/`).join('C:/')
        }

        env.push(`${name}=${rewritten}`)
    }

    if (containerWorkspace) {
        env.push(`GITHUB_WORKSPACE=${containerWorkspace}`)
    }

    return { env, containerWorkspace }
}

async function run(): Promise<void> {
    let dockerClient: ActionDockerClient | null = null
    let args: CliArgs | undefined
    try {
        args = parseArgs(process.argv.slice(2))
        dockerClient = await createDockerClient()

        const setOutput = await getCommandOutput(dockerClient, args.containerId, [
            'cmd',
            '/D',
            '/E:ON',
            '/V:OFF',
            '/S',
            '/C',
            'set'
        ])
        const containerVars = parseEnvLines(setOutput)

        const { env, containerWorkspace } = buildExecEnv(args.hostWorkspace, containerVars)
        const exec = await dockerClient.containerExec(args.containerId, {
            AttachStdout: true,
            AttachStderr: true,
            Env: env,
            WorkingDir: containerWorkspace || undefined,
            Cmd: buildShellCommand(args.shellName, args.scriptPath)
        })

        await dockerClient.execStart(exec.Id, process.stdout, process.stderr, {
            Tty: false,
            Detach: false
        })
        const inspect = await dockerClient.execInspect(exec.Id)
        process.exit(inspect.ExitCode ?? 1)
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const context = args
            ? `Failed to execute command in container '${args.containerId}' (shell: ${args.shellName})`
            : 'Failed to execute container command'
        process.stderr.write(`${context}: ${message}\n`)
        process.exit(1)
    } finally {
        if (dockerClient) {
            await closeDockerClient(dockerClient)
        }
    }
}

// Only execute when this module is the entry point (not when imported in tests).
const isMain =
    process.argv[1] &&
    fileURLToPath(import.meta.url).replace(/\.[jt]s$/, '') ===
        process.argv[1].replace(/\.[jt]s$/, '')
if (isMain) {
    run()
}
