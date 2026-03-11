import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as fs from 'node:fs'
import * as os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {
    CONTAINER_WORKSPACE,
    ENV_SCRIPT_NAME,
    Shell,
    env_script,
    wrapper
} from './shell-wrapper.js'

async function can_use_proc_isolation(imageName: string): Promise<boolean> {
    try {
        // 1. Get Host Build Version via PowerShell
        const hostBuildStr = os.release() // produces a string in the form of '10.0.26200', we need the 3rd segment for the build number
        const hostBuild = parseInt(hostBuildStr.split('.')[2])

        // 2. Get Image OS Version via Docker Inspect
        let imageOsVersion = ''
        await exec.exec('docker', ['inspect', '--format', '{{.OsVersion}}', imageName], {
            listeners: {
                stdout: (data) => {
                    imageOsVersion += data.toString()
                }
            }
        })

        // Image version format is usually "10.0.26100.4061" - we need the 3rd segment
        const imageBuild = parseInt(imageOsVersion.split('.')[2])

        core.debug(`Host Build: ${hostBuild} | Image Build: ${imageBuild}`)

        // 3. Compatibility Logic
        if (hostBuild === imageBuild) {
            core.debug('Perfect match. Process isolation is supported.')
            return true
        }

        if (hostBuild > imageBuild) {
            // Down-level compatibility requires Windows 11 (22000+) or Server 2022 (20348+)
            if (hostBuild >= 20348) {
                core.debug('Host supports down-level process isolation.')
                return true
            }
            core.warning(
                'Host is older than Windows 11/Server 2022. Exact version match required for process isolation. Expect performance degradation if running this image, and some features may not work as expected.'
            )
            return false
        }

        core.error(
            'Image build is newer than Host build. Running this image is not supported. Will attempt to run it, but expect it to fail.'
        )
    } catch (error) {
        core.setFailed(`Failed to inspect image: ${error instanceof Error ? error.message : error}`)
    }
    return false
}

async function docker_pull(image: string): Promise<string | null> {
    core.startGroup(`Pulling Docker image: ${image}`)
    if ((await exec.exec('docker', ['pull', '-q', image])) == 0) {
        core.info(`Successfully pulled Docker image: ${image}`)
        core.endGroup()
        return image
    }
    // The return code of docker images is 0 even if the image is not found,
    // so we need to check the output to determine if the image exists locally.
    let image_id = ''
    const imageCheckOptions: exec.ExecOptions = {
        listeners: {
            stdout: (data: Buffer) => {
                image_id += data.toString()
            }
        }
    }
    await exec.exec('docker', ['images', '-q', image], imageCheckOptions)
    image_id = image_id.trim()
    if (image_id.length > 0) {
        core.info(`Using pre-existing Docker image: ${image}`)
        core.endGroup()
        return image
    }
    core.setFailed(`Docker image not found locally: ${image}`)
    core.endGroup()
    return null
}

async function docker_run(image: string): Promise<string> {
    core.startGroup(`Running Docker container from image: ${image}`)
    const github_workspace = process.env.GITHUB_WORKSPACE
    if (!github_workspace) {
        core.setFailed('GITHUB_WORKSPACE environment variable is not set.')
        core.endGroup()
        return ''
    }
    let container_id = ''
    const options: exec.ExecOptions = {
        listeners: {
            stdout: (data: Buffer) => {
                container_id += data.toString()
            }
        }
    }

    const isolation = (await can_use_proc_isolation(image)) ? 'process' : 'hyperv'
    core.info(`Using ${isolation} isolation for container.`)

    const args = [
        'run',
        '--rm',
        `--isolation=${isolation}`,
        // Set the --cpus flag since hyper-v isolation defaults to only "exposing" 2 CPUs to the container.
        ...(isolation === 'hyperv' ? ['--cpus', os.availableParallelism().toString()] : []),
        // Set memory as well, since it defaults to only 1GB. Limit to 80% of total memory to leave some overhead for the host. Might need to adjust this later.
        ...(isolation === 'hyperv' ? ['--memory', Math.round(os.totalmem() * 0.8).toString()] : []),
        '-d',
        '-v',
        `${github_workspace}:${CONTAINER_WORKSPACE}`,
        '-w',
        CONTAINER_WORKSPACE,
        '-e',
        `GITHUB_WORKSPACE=${CONTAINER_WORKSPACE}`,
        image,
        'powershell',
        '-Command',
        'while (1) { Start-Sleep -Seconds 2147483 }'
    ]

    if ((await exec.exec('docker', args, options)) !== 0) {
        core.setFailed(`Failed to run Docker container from image: ${image}`)
        core.endGroup()
        return ''
    }
    container_id = container_id.trim()
    core.setOutput('container_id', container_id)
    core.endGroup()
    return container_id
}

async function setup_container_wrappers(path_dir: string, container_id: string): Promise<void> {
    core.startGroup(`Setting up wrapper with ID: ${container_id}`)

    // Generate the PowerShell environment script
    const env_script_content = env_script()
    const env_script_path = path.join(path_dir, ENV_SCRIPT_NAME)
    core.info(`Creating environment generation script at ${env_script_path}`)
    fs.writeFileSync(env_script_path, env_script_content)

    // Generate wrapper scripts for each shell
    for (const [shell_name, shell_command] of Object.entries(Shell)) {
        const wrapper_content = wrapper(shell_command, container_id, CONTAINER_WORKSPACE, path_dir)
        const wrapper_path = path.join(path_dir, `${shell_name}-in-container.cmd`)
        core.info(`Creating wrapper for ${shell_name} at ${wrapper_path} with ${shell_command}`)
        fs.writeFileSync(wrapper_path, wrapper_content)
    }

    core.addPath(path_dir)
    core.endGroup()
}

async function run(): Promise<void> {
    try {
        if (process.platform !== 'win32') {
            core.setFailed('This action can only be run on Windows runners.')
            return
        }
        const temp_dir = process.env.RUNNER_TEMP
        if (!temp_dir) {
            core.setFailed('RUNNER_TEMP environment variable is not set.')
            return
        }
        const image: string = core.getInput('image').trim()
        if (!image) {
            core.setFailed('Image name is required.')
            return
        }

        const path_dir = path.join(temp_dir, 'container-wrapper')
        fs.mkdirSync(path_dir, { recursive: true })
        const container_id_store = path.join(path_dir, '.container_id')

        if (fs.existsSync(container_id_store)) {
            core.warning(
                'A container ID file already exists. This may indicate that a container is still running from a previous execution. Attempting to clean up before proceeding.'
            )
            const container_id = fs.readFileSync(container_id_store, 'utf-8').trim()
            if (container_id) {
                core.info(`Attempting to stop existing container with ID: ${container_id}`)
                await exec.exec('docker', ['stop', '-t', '10', container_id])
            }
            fs.rmSync(path_dir, { recursive: true, force: true })
            fs.mkdirSync(path_dir, { recursive: true })
        }

        const final_image = await docker_pull(image)
        if (!final_image) {
            return
        }
        const container_id = await docker_run(final_image)
        if (!container_id) {
            return
        }

        fs.writeFileSync(container_id_store, container_id)
        await setup_container_wrappers(path_dir, container_id)
    } catch (error: unknown) {
        if (error instanceof Error) {
            core.setFailed(error.message)
        } else {
            core.setFailed(String(error))
        }
    }
}

run()
