const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Express middleware to validate UUID route parameters.
 * If the parameter is not a valid UUID, it triggers a 404 error (or passes to the next router/handler).
 * @param {string} paramName - The parameter name to validate (defaults to 'id').
 */
export const validateUuid = (paramName = "id") => {
  return (req, res, next) => {
    const value = req.params[paramName];
    if (!value || !uuidRegex.test(value)) {
      const err = new Error("Resource not found");
      err.status = 404;
      return next(err);
    }
    next();
  };
};

export default validateUuid;
