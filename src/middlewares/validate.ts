'use strict';

/**
 * Zod validation middleware factory.
 *
 * Validates `req.body` against the given Zod schema.
 * On success, replaces `req.body` with the parsed (and type-coerced) result
 * so downstream handlers can use correctly-typed values directly.
 * On failure, responds 400 with structured error details.
 */
function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body ?? {});
    if (!result.success) {
      return res.status(400).json({
        error: 'Invalid input',
        details: result.error.issues.map((i) => ({
          field: i.path.join('.'),
          message: i.message,
        })),
      });
    }
    req.body = result.data;
    next();
  };
}

module.exports = { validate };
