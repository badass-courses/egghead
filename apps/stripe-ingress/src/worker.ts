import { handleIngress, type IngressBindings } from "./handler.js";

export default {
  fetch(request: Request, bindings: IngressBindings): Promise<Response> {
    return handleIngress(request, bindings);
  },
};
