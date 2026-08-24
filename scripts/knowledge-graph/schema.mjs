import { readFile } from 'node:fs/promises'
import Ajv2020 from 'ajv/dist/2020.js'
import { fail } from './diagnostics.mjs'
import { parseStrictJson } from './strict-json.mjs'

export async function loadSchema(schemaPath) {
  const raw = await readFile(schemaPath, 'utf8')
  return parseStrictJson(raw, schemaPath)
}

export function compileSchema(schema) {
  let validate
  try {
    const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true, validateFormats: false })
    validate = ajv.compile(schema)
  } catch (error) {
    fail('KG_SCHEMA_INVALID', error instanceof Error ? error.message : String(error))
  }
  return value => {
    if (validate(value)) return
    const details = (validate.errors ?? []).map(error => `${error.instancePath || '$'} ${error.message}`).join('; ')
    fail('KG_SCHEMA_MISMATCH', details)
  }
}
