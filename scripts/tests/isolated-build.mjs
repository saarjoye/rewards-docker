import Module from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../../', import.meta.url))
const original = Module._resolveFilename
// Offline regression tests load the isolated compiler output, never runtime dist.
Module._resolveFilename = function (request, parent, ...rest) {
    if (request.startsWith('.') && parent?.filename) {
        const resolved = path.resolve(path.dirname(parent.filename), request)
        const relative = path.relative(path.join(root, 'dist'), resolved)
        if (!relative.startsWith('..') && !path.isAbsolute(relative))
            request = path.join(root, '.codex-output/credit-build', relative)
    }
    return original.call(this, request, parent, ...rest)
}
