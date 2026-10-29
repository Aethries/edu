export type ApiErrorResponse = {
    error: {
        code:
            | "NOT_FOUND"
            | "INTERNAL_ERROR"
            | "VALIDATION_ERROR"
            | `HTTP_${number}`;
        requestId: string;
    };
};
