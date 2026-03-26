/**
 * Centralised error handler — mount this LAST in app.js after all routes.
 * Any route/middleware that calls next(err) or throws inside an async wrapper
 * will land here.
 */
const errorHandler = (err, req, res, next) => {
  console.error(`[${new Date().toISOString()}] ${req.method} ${req.path}`, err);

  // Honour a status code already set on the error, otherwise default to 500
  const status = err.status ?? err.statusCode ?? 500;

  res.status(status).json({
    success: false,
    message: err.message ?? "An unexpected error occurred",
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
  });
};

export default errorHandler;
