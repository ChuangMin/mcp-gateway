/** The Gateway reads time only through a Clock, so tests can control it. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};
