// See: https://rollupjs.org/introduction/

import alias from '@rollup/plugin-alias'
import commonjs from '@rollup/plugin-commonjs'
import json from '@rollup/plugin-json'
import nodeResolve from '@rollup/plugin-node-resolve'
import typescript from '@rollup/plugin-typescript'
import { resolve } from 'node:path'
import { defineConfig } from 'rollup'

const config = defineConfig({
    input: {
        index: 'src/index.ts',
        post: 'src/post.ts'
    },
    output: [
        {
            dir: 'dist',
            entryFileNames: '[name].js',
            esModule: true,
            format: 'es',
            sourcemap: true
        }
    ],
    plugins: [
        alias({
            entries: [{ find: 'ssh2', replacement: resolve('src/shims/ssh2.ts') }]
        }),
        typescript({ tsconfig: './tsconfig.json' }),
        nodeResolve({ preferBuiltins: true }),
        json(),
        commonjs()
    ]
})

export default config
