// UDS hydraulics (GDD 06): walk a plant→stope path and build the pressure
// profile. Gravity adds head (ρgh) down boreholes; friction consumes it; a
// choke at the HEAD of a segment dissipates excess head (protecting that leg and
// everything below it, without starving taps that branch off above it); a
// booster adds head. The HGL must stay below each segment's rating (or it
// bursts) and above slack (or the line runs empty and wears).

import { G, PASTE_DENSITY, CHOKE_DROP_MPA, BOOSTER_ADD_MPA, SLACK_MIN_MPA, CHOKE_CAPEX, BOOSTER_CAPEX } from "./constants.js";
import { PIPE_CLASSES, pathSegmentsFor, segmentById, nodeById } from "./scenario.js";
import type { PathProfile, SegProfile, PathNode, LineProfile, Station } from "./types.js";

export interface NetworkState {
  segClass: Record<string, number | null>;
  segStation: Record<string, Station>;
}

const staticMpa = (dz: number) => (PASTE_DENSITY * G * dz) / 1e6;

export function computePathProfile(
  stopeId: string,
  net: NetworkState,
  frictionBaseKpaPerM: number,
): PathProfile {
  const segIds = pathSegmentsFor(stopeId);
  const segs: SegProfile[] = [];
  const nodes: PathNode[] = [];
  let P = 0;
  let peakP = 0;
  let minRating = Infinity;
  let allBuilt = true;
  let burst = false;
  let slack = false;
  let issue = "";

  const first = nodeById(segIds.length ? segmentById(segIds[0]).from : "plant");
  nodes.push({ id: first.id, depthM: first.depthM, xM: first.xM, P: 0 });

  for (const segId of segIds) {
    const spec = segmentById(segId);
    const ci = net.segClass[segId];
    const station = net.segStation[segId] ?? null;
    const headP = P;

    if (ci == null) {
      allBuilt = false;
      segs.push({ segId, classIndex: null, station, headP, startP: headP, endP: headP, maxP: headP, ratingMpa: 0, burst: false, slack: false });
      if (!issue) issue = `${label(segId)} not built`;
      nodes.push({ id: spec.to, depthM: nodeById(spec.to).depthM, xM: nodeById(spec.to).xM, P: headP });
      continue;
    }

    // Station at the head of this segment (affects this leg only).
    let startP = headP;
    if (station === "choke") startP = Math.max(0, headP - CHOKE_DROP_MPA);
    else if (station === "booster") startP = headP + BOOSTER_ADD_MPA;

    const cls = PIPE_CLASSES[ci];
    const friction = frictionBaseKpaPerM * cls.frictionMult;
    const fMpa = (friction * spec.lengthM) / 1000;
    const sMpa = staticMpa(spec.depthChangeM);
    const endP = startP + sMpa - fMpa;
    const maxP = spec.kind === "borehole" ? Math.max(startP, endP) : startP;
    const segBurst = maxP > cls.ratingMpa + 1e-6;
    const segSlack = endP < SLACK_MIN_MPA;
    if (segBurst) { burst = true; if (!issue) issue = `${label(segId)} bursts: ${maxP.toFixed(1)} > ${cls.ratingMpa} MPa`; }
    if (segSlack) { slack = true; if (!issue) issue = `${label(segId)} runs slack (${endP.toFixed(1)} MPa) — won't stay full`; }

    segs.push({ segId, classIndex: ci, station, headP, startP, endP, maxP, ratingMpa: cls.ratingMpa, burst: segBurst, slack: segSlack });
    peakP = Math.max(peakP, maxP);
    minRating = Math.min(minRating, cls.ratingMpa);
    P = endP;
    nodes.push({ id: spec.to, depthM: nodeById(spec.to).depthM, xM: nodeById(spec.to).xM, P });
  }

  const deliveredP = P;
  if (allBuilt && !burst && !slack && deliveredP < SLACK_MIN_MPA && !issue) issue = "line does not deliver to the stope";
  const reticulated = allBuilt && !burst && !slack && deliveredP >= SLACK_MIN_MPA;

  return { segs, nodes, peakP, minRating: isFinite(minRating) ? minRating : 0, deliveredP, allBuilt, burst, slack, reticulated, issue };
}

export function lineProfileFrom(pp: PathProfile): LineProfile {
  const staticHead = pp.nodes.length ? staticMpa(pp.nodes[pp.nodes.length - 1].depthM) : 0;
  const frictionLoss = pp.segs.reduce((a, s) => {
    if (s.classIndex == null) return a;
    const spec = segmentById(s.segId);
    return a + Math.max(0, staticMpa(spec.depthChangeM) - (s.endP - s.startP));
  }, 0);
  return {
    ratingMpa: pp.minRating,
    peakPressureMpa: pp.peakP,
    frictionLossMpa: frictionLoss,
    staticHeadMpa: staticHead,
    slack: pp.slack,
    delivered: pp.deliveredP >= SLACK_MIN_MPA,
    reticulated: pp.reticulated,
  };
}

export function stationCapex(station: Station): number {
  return station === "choke" ? CHOKE_CAPEX : station === "booster" ? BOOSTER_CAPEX : 0;
}

function label(segId: string): string {
  return segmentById(segId).kind === "borehole" ? `Borehole ${segId.replace("bh", "")}m` : `Level run ${segId}`;
}
