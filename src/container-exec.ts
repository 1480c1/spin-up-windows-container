import { Writable } from 'node:stream'
import process from 'node:process'
import {
    close_docker_client,
    create_docker_client,
    type ActionDockerClient
} from './docker-client.js'

type CliArgs = {
    containerId: string
    shellName: string
    scriptPath: string
    hostWorkspace: string
}

function parse_args(argv: string[]): CliArgs {
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

function parse_env_lines(envOutput: string): Map<string, string> {
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

function build_shell_command(shellName: string, scriptPath: string): string[] {
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

async function get_command_output(
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

function build_exec_env(
    hostWorkspace: string,
    containerVars: Map<string, string>
): { env: string[]; containerWorkspace: string } {
    const containerWorkspace = containerVars.get('GITHUB_WORKSPACE') || ''
    const env: string[] = []
    const oldPathFwd = hostWorkspace.replaceAll('\\', '/')
    const newPathFwd = containerWorkspace.replaceAll('\\', '/')

    for (const [name, value] of Object.entries(process.env)) {
        if (!value || name.toUpperCase() === 'PATH') {
            continue
        }
        if (containerVars.has(name.toUpperCase())) {
            continue
        }

        let rewritten = value
        if (hostWorkspace && containerWorkspace) {
            rewritten = rewritten.split(hostWorkspace).join(containerWorkspace)
            rewritten = rewritten.split(oldPathFwd).join(newPathFwd)
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
    try {
        const args = parse_args(process.argv.slice(2))
        dockerClient = await create_docker_client()

        const setOutput = await get_command_output(dockerClient, args.containerId, [
            'cmd',
            '/D',
            '/E:ON',
            '/V:OFF',
            '/S',
            '/C',
            'set'
        ])
        const containerVars = parse_env_lines(setOutput)

        const { env, containerWorkspace } = build_exec_env(args.hostWorkspace, containerVars)
        const exec = await dockerClient.containerExec(args.containerId, {
            AttachStdout: true,
            AttachStderr: true,
            Env: env,
            WorkingDir: containerWorkspace || undefined,
            Cmd: build_shell_command(args.shellName, args.scriptPath)
        })

        await dockerClient.execStart(exec.Id, process.stdout, process.stderr, {
            Tty: false,
            Detach: false
        })
        const inspect = await dockerClient.execInspect(exec.Id)
        process.exit(inspect.ExitCode ?? 1)
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        process.stderr.write(`${message}\n`)
        process.exit(1)
    } finally {
        if (dockerClient) {
            await close_docker_client(dockerClient)
        }
    }
}

run()
