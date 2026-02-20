import { Validator } from '@tailoredshapes/meshql-common';
import Ajv, { Ajv as AjvType } from 'ajv';
import addFormats from 'ajv-formats';

export function JSONSchemaValidator(schema: Record<string, any>): Validator {
    const ajv: AjvType = new Ajv();
    addFormats(ajv); // Ensure this is callable
    ajv.addKeyword('faker');

    const validate = ajv.compile(schema);

    return async (data) => validate(data);
}
