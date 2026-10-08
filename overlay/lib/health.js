// Turns the backend's /health result (or the failure to reach it) into one
// actionable sentence for the overlay. Pure, so it's unit-tested.

function describeHealth({ backendUrl, error, status, report }) {
  if (error) {
    return `Backend not reachable at ${backendUrl}. Start it with: cd server && npm run dev`;
  }
  if (!report || typeof report !== 'object') {
    return `Backend at ${backendUrl} answered /health with status ${status}`;
  }
  if (report.ok) return null;

  const { ollama = {}, models = {} } = report;
  if (!ollama.reachable) {
    return `Ollama isn't running at ${ollama.url || 'its configured URL'}. Start it with: ollama serve`;
  }

  const missing = [];
  if (models.vision && !models.vision.installed) missing.push(models.vision.name);
  if (models.text && models.fallback && !models.text.installed && !models.fallback.installed) {
    missing.push(models.text.name);
  }
  if (missing.length > 0) {
    return `Missing Ollama model${missing.length > 1 ? 's' : ''}. Run: ${missing
      .map((name) => `ollama pull ${name}`)
      .join(' && ')}`;
  }
  return 'Backend reports it is not ready';
}

module.exports = { describeHealth };
