import { describe, expect, test, jest } from '@jest/globals'
import {
    create_and_start_container,
    get_image_os_version,
    image_exists_locally,
    pull_image,
    stop_container,
    type ActionDockerClient
} from '../src/docker-client.js'

function mockClient(overrides: Partial<ActionDockerClient>): ActionDockerClient {
    return overrides as ActionDockerClient
}

describe('docker-client helpers', () => {
    test('get_image_os_version returns OsVersion from image inspect', async () => {
        const client = mockClient({
            imageInspect: jest.fn().mockResolvedValue({ OsVersion: '10.0.26100.4061' })
        })

        await expect(
            get_image_os_version(client, 'mcr.microsoft.com/windows/servercore:ltsc2025')
        ).resolves.toBe('10.0.26100.4061')
    })

    test('get_image_os_version throws when image has no OsVersion', async () => {
        const client = mockClient({
            imageInspect: jest.fn().mockResolvedValue({})
        })

        await expect(get_image_os_version(client, 'image:tag')).rejects.toThrow(
            'does not have an OsVersion field'
        )
    })

    test('pull_image splits tag from reference before imageCreate', async () => {
        const wait = jest.fn().mockResolvedValue('sha256:digest')
        const imageCreate = jest.fn().mockReturnValue({ wait })
        const client = mockClient({ imageCreate })

        await pull_image(client, 'repo/name:custom-tag')

        expect(imageCreate).toHaveBeenCalledWith({ fromImage: 'repo/name', tag: 'custom-tag' })
        expect(wait).toHaveBeenCalledTimes(1)
    })

    test('pull_image keeps digest references intact', async () => {
        const wait = jest.fn().mockResolvedValue('sha256:digest')
        const imageCreate = jest.fn().mockReturnValue({ wait })
        const client = mockClient({ imageCreate })

        await pull_image(client, 'repo/name@sha256:abc123')

        expect(imageCreate).toHaveBeenCalledWith({ fromImage: 'repo/name@sha256:abc123' })
    })

    test('image_exists_locally returns false on inspection error', async () => {
        const client = mockClient({
            imageInspect: jest.fn().mockRejectedValue(new Error('not found'))
        })

        await expect(image_exists_locally(client, 'missing:image')).resolves.toBe(false)
    })

    test('create_and_start_container maps configuration and starts container', async () => {
        const containerStart = jest.fn().mockResolvedValue(undefined)
        const containerCreate = jest.fn().mockResolvedValue({ Id: 'abc123' })
        const client = mockClient({ containerCreate, containerStart })

        const id = await create_and_start_container(
            client,
            'image:tag',
            'C:\\host-workspace',
            'C:\\workspace',
            'hyperv',
            8,
            1024
        )

        expect(id).toBe('abc123')
        expect(containerCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                Image: 'image:tag',
                WorkingDir: 'C:\\workspace',
                Env: ['GITHUB_WORKSPACE=C:\\workspace'],
                HostConfig: expect.objectContaining({
                    AutoRemove: true,
                    Isolation: 'hyperv',
                    Binds: ['C:\\host-workspace:C:\\workspace'],
                    CpuCount: 8,
                    Memory: 1024
                })
            })
        )
        expect(containerStart).toHaveBeenCalledWith('abc123')
    })

    test('stop_container forwards timeout', async () => {
        const containerStop = jest.fn().mockResolvedValue(undefined)
        const client = mockClient({ containerStop })

        await stop_container(client, 'container-id', 10)

        expect(containerStop).toHaveBeenCalledWith('container-id', { timeout: 10 })
    })
})
