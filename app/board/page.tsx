import { PipelinePanel } from "../../components/pramaan/pipeline/pipeline-panel";
export default function Page() {
  return (
    <main className="workspace">
      <h1>Deals and sprint board</h1>
      <p>
        Track a deal or choose Task for sprint work. Move cards as work progresses. Owner is a
        label; it does not grant access.
      </p>
      <PipelinePanel />
    </main>
  );
}
