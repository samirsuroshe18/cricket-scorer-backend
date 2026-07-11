class ApiError extends Error {
    constructor(statusCode, message = 'Something went wrong', options = {}) {
        super(message);
        this.statusCode = statusCode;
        this.message = message;
        this.localFilePath = options.localFilePath || null;
        this.params = options.params || {};
        this.isApiError = true;
    }
}

export default ApiError