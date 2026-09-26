/** Only fixed, non-secret public messages belong in this error type. */
export class PronunciationError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'PronunciationError';
    this.status = status;
  }
}
