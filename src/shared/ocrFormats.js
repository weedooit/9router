export const defaultTemplate = JSON.stringify({ image: "{{base64}}" }, null, 2);

export function newOcrModel() {
  return {
    id: "", endpoint: "", requestFormat: "multipart", fileField: "file",
    upstreamModel: "", jsonTemplate: defaultTemplate, responseFormat: "results", textPath: "",
  };
}
