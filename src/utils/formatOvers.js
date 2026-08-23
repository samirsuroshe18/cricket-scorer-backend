export const formatOvers = (oversCompleted, legalBalls) => {
    const ballsInCurrentOver = legalBalls - oversCompleted * 6;
    return `${oversCompleted}.${ballsInCurrentOver}`;
};
