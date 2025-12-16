let validatorId: string | null = null;

export const setValidatorId = (id: string) => {
    validatorId = id;
};

export const getValidatorId = (): string => {
    if (!validatorId) {
        throw new Error('validatorId not initialized');
    }

    return validatorId;
};

export const hasValidatorId = (): boolean => validatorId !== null;
