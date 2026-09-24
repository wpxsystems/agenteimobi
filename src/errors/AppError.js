'use strict';

/**
 * Erro de domínio tipado. O errorHandler converte em `{ success: false, error: { code, message } }`
 * sem vazar stack nem SQL.
 */
class AppError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }

  static notFound(what = 'Recurso') {
    return new AppError('NOT_FOUND', `${what} não encontrado`, 404);
  }

  static unauthorized(message = 'Não autenticado') {
    return new AppError('UNAUTHORIZED', message, 401);
  }

  static forbidden(message = 'Sem permissão') {
    return new AppError('FORBIDDEN', message, 403);
  }

  static conflict(message) {
    return new AppError('CONFLICT', message, 409);
  }

  static validation(details) {
    return new AppError('VALIDATION_ERROR', 'Dados inválidos', 422, details);
  }
}

module.exports = AppError;
