import { getLocalDockerDbProof } from "../../../../db/local-docker";

export async function GET() {
  const proof = await getLocalDockerDbProof();
  const status = proof.ok ? 200 : 503;

  return Response.json(proof, { status });
}
