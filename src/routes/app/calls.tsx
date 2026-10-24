import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { correctDisposition, getCallRecording, listCalls } from "@/server/calls";
import { listCampaigns } from "@/server/campaigns";
import { useWorkspace, PageTitle } from "@/components/workspace";
import { Banner, Button, Field, Panel, SelectInput, TextInput } from "@/components/bits";
import { DISPOSITIONS } from "@/lib/dialer/dispositions";
import { DISPOSITION_LABEL, STATE_LABEL } from "@/lib/dialer/labels";
import { errorText, formatDuration, formatWhen, isoDate } from "@/lib/dialer/format";

export const Route = createFileRoute("/app/calls")({ component: CallsPage });

function CallsPage() {
  const { membership, allow } = useWorkspace();
  const client = useQueryClient();
  const [from, setFrom] = useState(isoDate(-13));
  const [to, setTo] = useState(isoDate(0));
  const [campaignId, setCampaignId] = useState("");
  const [disposition, setDisposition] = useState("");
  const [page, setPage] = useState(1);
  const [audioSrc, setAudioSrc] = useState("");
  const [playingId, setPlayingId] = useState("");
  const campaigns = useQuery({
    queryKey: ["campaigns", membership.orgId, "all"],
    queryFn: () => listCampaigns({ data: { orgId: membership.orgId, status: "all" } }),
  });
  const calls = useQuery({
    queryKey: ["calls", membership.orgId, from, to, campaignId, disposition, page],
    queryFn: () => listCalls({ data: { orgId: membership.orgId, from, to, campaignId, disposition, page, pageSize: 25 } }),
  });
  const total = calls.data?.total ?? 0;
  return (
    <>
      <PageTitle title="History" lane="Work" steps={[{ label: "Filter", href: "#filter" }, { label: "Review", href: "#review" }]} />
      <p className="text-sm text-fog">{allow("view_all_calls") ? "Every call in the workspace." : "Only calls you placed."} Dates use the workspace timezone.</p>
      <div id="filter" className="grid gap-3 md:grid-cols-4">
        <Field label="From">
          <TextInput type="date" value={from} onChange={(event) => { setFrom(event.target.value); setPage(1); }} />
        </Field>
        <Field label="To">
          <TextInput type="date" value={to} onChange={(event) => { setTo(event.target.value); setPage(1); }} />
        </Field>
        <Field label="Campaign">
          <SelectInput value={campaignId} onChange={(event) => setCampaignId(event.target.value)}>
            <option value="">All</option>
            {(campaigns.data?.campaigns ?? []).map((campaign) => (
              <option key={campaign.id} value={campaign.id}>{campaign.name}</option>
            ))}
          </SelectInput>
        </Field>
        <Field label="Disposition">
          <SelectInput value={disposition} onChange={(event) => setDisposition(event.target.value)}>
            <option value="">All</option>
            {DISPOSITIONS.map((item) => (
              <option key={item} value={item}>{DISPOSITION_LABEL[item]}</option>
            ))}
          </SelectInput>
        </Field>
      </div>
      {calls.isError ? <Banner tone="bad">{errorText(calls.error)}</Banner> : null}
      <Panel title={`${total} in range`} id="review">
        <div className="overflow-x-auto">
          <table className="data-table min-w-[720px]">
            <thead className="text-xs text-fog uppercase">
              <tr>
                <th className="py-2">When</th>
                <th>Contact</th>
                <th>State</th>
                <th>Disposition</th>
                <th>Duration</th>
                <th>Proof</th>
                <th>Recording</th>
              </tr>
            </thead>
            <tbody>
              {(calls.data?.calls ?? []).map((call) => (
                <tr key={call.id} className="border-t border-line">
                  <td className="py-2">{formatWhen(call.startedAt)}</td>
                  <td className="num">{call.contactName || call.toDisplay}</td>
                  <td>{STATE_LABEL[call.state] ?? call.state}</td>
                  <td>
                    {allow("correct_disposition") && call.disposition ? (
                      <SelectInput
                        defaultValue={call.disposition}
                        aria-label="Correct disposition"
                        onChange={(event) => {
                          void correctDisposition({ data: { orgId: membership.orgId, callId: call.id, disposition: event.target.value } })
                            .then(() => {
                              toast.success("Disposition corrected");
                              void client.invalidateQueries({ queryKey: ["calls"] });
                            })
                            .catch((error: unknown) => toast.error(errorText(error)));
                        }}
                      >
                        {DISPOSITIONS.filter((item) => item !== "skipped").map((item) => (
                          <option key={item} value={item}>{DISPOSITION_LABEL[item]}</option>
                        ))}
                      </SelectInput>
                    ) : (
                      DISPOSITION_LABEL[call.disposition] || "—"
                    )}
                  </td>
                  <td>{formatDuration(call.durationSeconds)}</td>
                  <td>{call.providerVerified ? "Provider" : call.channel === "manual_device" ? "Agent reported" : "Unverified"}</td>
                  <td>
                    {call.hasRecording ? (
                      <Button
                        type="button"
                        variant="quiet"
                        disabled={playingId === call.id}
                        onClick={() => {
                          setPlayingId(call.id);
                          void getCallRecording({ data: { orgId: membership.orgId, callId: call.id } })
                            .then((result) => setAudioSrc(`data:${result.mime};base64,${result.audioBase64}`))
                            .catch((error: unknown) => toast.error(errorText(error)))
                            .finally(() => setPlayingId(""));
                        }}
                      >
                        Play
                      </Button>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-3 flex gap-2">
          <Button type="button" variant="ghost" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Previous</Button>
          <Button type="button" variant="ghost" disabled={page * 25 >= total} onClick={() => setPage((value) => value + 1)}>Next</Button>
        </div>
        {audioSrc ? <audio className="mt-3 w-full" controls autoPlay src={audioSrc} /> : null}
      </Panel>
    </>
  );
}
