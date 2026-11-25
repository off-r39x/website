/** A failure of the service (not of the input): the only alert of the form while it is shown. */
export function ServiceFailure({ message }: { message: string }) {
  return (
    <p role="alert" className="alert block">
      <span className="error-dot" aria-hidden="true" />
      {message}
    </p>
  );
}
