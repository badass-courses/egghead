import { getRuntimeDbProof } from "../../../../db/local-docker";

export async function GET() {
  const proof = await getRuntimeDbProof();
  const status = proof.ok ? 200 : 503;

  return Response.json(proof, { status });
}
