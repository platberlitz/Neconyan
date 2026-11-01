export const forbiddenRegExp = /[/\\\x00]/;

/**
 * Gets a middleware function that validates the field in the request body.
 * @param {string} fieldName Field name
 * @returns {import('express').RequestHandler} Middleware function
 */
export function getFileNameValidationFunction(fieldName) {
    /**
    * Validates the field in the request body.
    * @param {import('express').Request} req Request object
    * @param {import('express').Response} res Response object
    * @param {import('express').NextFunction} next Next middleware
    */
    return function validateAvatarUrlMiddleware(req, res, next) {
        if (req.body && fieldName in req.body) {
            const value = req.body[fieldName];
            if (value !== undefined && value !== null) {
                if (typeof value !== 'string' || value === '.' || value === '..' || forbiddenRegExp.test(value)) {
                    console.error('An error occurred while validating the request body', {
                        handle: req.user?.profile?.handle,
                        path: req.originalUrl,
                        field: fieldName,
                        value,
                    });
                    return res.sendStatus(400);
                }
            }
        }

        next();
    };
}

const avatarUrlValidationFunction = getFileNameValidationFunction('avatar_url');
export default avatarUrlValidationFunction;
