export function gatewayCreationFeedback(result: {
  id: string
  label: string
  credential?: string
}):
  | { credential: string; lost?: undefined }
  | { credential?: undefined; lost: { id: string; label: string } } {
  return result.credential ?
      { credential: result.credential }
    : { lost: { id: result.id, label: result.label } }
}
