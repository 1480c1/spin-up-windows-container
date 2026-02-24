// See: https://rollupjs.org/introduction/

import commonjs from '@rollup/plugin-commonjs'
import nodeResolve from '@rollup/plugin-node-resolve'
import typescript from '@rollup/plugin-typescript'
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
        typescript({ tsconfig: './tsconfig.json' }),
        nodeResolve({ preferBuiltins: true }),
        commonjs()
    ]
})

export default config
