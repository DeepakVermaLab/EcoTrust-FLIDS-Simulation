(function () {
  "use strict";

  const DATA = window.ECOTRUST_DATA;
  if (!DATA) {
    document.body.innerHTML = "<main style='padding:40px;font-family:sans-serif'><h1>Evidence bundle missing</h1><p>Run scripts/build_site_data.py before previewing this page.</p></main>";
    return;
  }

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const policyLabels = {
    all_clients: "All clients",
    random_budget: "Random budget",
    round_robin: "Round robin",
    static_score: "Static score",
    telemetry_heuristic: "Telemetry heuristic",
    learned_policy: "Learned policy",
  };
  const datasetSeeds = { "Edge-IIoTset": 1103, "TON_IoT": 2207, "CICIoT2023": 3313 };
  let currentRound = 1;
  let currentClients = [];
  let selectedClientId = null;
  let policyDataset = "TON_IoT";

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function mulberry32(seed) {
    return function () {
      let t = (seed += 0x6d2b79f5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function formatNumber(value, digits = 2) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
    return Number(value).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  function bytesLabel(bytes) {
    if (!Number.isFinite(bytes)) return "—";
    if (bytes >= 1e9) return `${formatNumber(bytes / 1e9, 2)} GB`;
    return `${formatNumber(bytes / 1e6, 2)} MB`;
  }

  function getControls() {
    return {
      dataset: $("#datasetSelect").value,
      policy: $("#policySelect").value,
      budget: Number($("#budgetRange").value) / 100,
      minTrust: Number($("#trustRange").value),
      minEnergy: Number($("#energyRange").value),
      driftStress: Number($("#driftRange").value) / 100,
      latency: Number($("#latencyRange").value),
      round: currentRound,
    };
  }

  function generateClients(controls) {
    const random = mulberry32(datasetSeeds[controls.dataset] + controls.round * 97);
    const clients = Array.from({ length: 20 }, (_, index) => {
      const trust = clamp(0.48 + random() * 0.49 - controls.driftStress * random() * 0.08, 0.30, 0.99);
      const energy = Math.round(75 + random() * 1525 - controls.driftStress * random() * 110);
      const recentLoss = clamp(0.045 + random() * 0.34 + controls.driftStress * 0.08, 0.02, 0.70);
      const recentF1 = clamp(0.76 + random() * 0.23 - controls.driftStress * 0.08, 0.45, 1);
      const drift = clamp(random() * 0.62 + controls.driftStress * 0.38, 0, 1);
      const latency = clamp(controls.latency * (0.55 + random() * 0.9), 0, 1200);
      return {
        id: `C${String(index + 1).padStart(2, "0")}`,
        index,
        trust,
        energy,
        recentLoss,
        recentF1,
        drift,
        latency,
      };
    });

    clients.forEach((client) => {
      const energyTerm = Math.min(client.energy / DATA.controller.energy_normalizer_j, 1);
      const qualityTerm = Math.max(0, 1 - client.recentLoss) * 0.4 + client.recentF1 * 0.6;
      const driftTerm = Math.min(client.drift, 1) * DATA.controller.drift_boost;
      const latencyTerm = Math.min(client.latency / DATA.controller.latency_normalizer_ms, 1);
      client.contributions = {
        trust: client.trust * DATA.controller.trust_weight,
        energy: energyTerm * DATA.controller.energy_weight,
        quality: qualityTerm * DATA.controller.quality_weight,
        drift: driftTerm,
        latency: -latencyTerm * DATA.controller.latency_weight,
      };
      client.score = Object.values(client.contributions).reduce((sum, value) => sum + value, 0);
      client.staticScore = client.trust * 0.65 + energyTerm * 0.35;
      client.eligible = client.trust >= controls.minTrust && client.energy >= controls.minEnergy;
    });

    const target = controls.policy === "all_clients" ? clients.length : Math.max(1, Math.round(clients.length * controls.budget));
    let ranked;
    if (controls.policy === "telemetry_heuristic") {
      ranked = [...clients].sort((a, b) => b.score - a.score);
    } else if (controls.policy === "static_score") {
      ranked = [...clients].sort((a, b) => b.staticScore - a.staticScore);
    } else if (controls.policy === "round_robin") {
      ranked = [...clients].sort((a, b) => ((a.index - controls.round + 40) % 20) - ((b.index - controls.round + 40) % 20));
    } else {
      ranked = [...clients];
    }

    const gated = controls.policy === "telemetry_heuristic" || controls.policy === "static_score";
    const selectedIds = new Set(
      ranked.filter((client) => !gated || client.eligible).slice(0, target).map((client) => client.id)
    );
    clients.forEach((client) => {
      if (gated && client.trust < controls.minTrust) {
        client.decision = "excluded";
        client.reason = "low_trust";
        client.sleepRounds = 3;
      } else if (gated && client.energy < controls.minEnergy) {
        client.decision = "excluded";
        client.reason = "low_energy";
        client.sleepRounds = 3;
      } else if (selectedIds.has(client.id)) {
        client.decision = "selected";
        client.reason = "selected";
        client.sleepRounds = 0;
      } else {
        client.decision = "sleeping";
        client.reason = "energy_save_sleep";
        client.sleepRounds = client.drift > 0.5 ? 1 : 2;
      }
    });
    return clients;
  }

  function renderNetwork(clients) {
    const svg = $("#networkSvg");
    const centerX = 410;
    const centerY = 230;
    const radiusX = 345;
    const radiusY = 185;
    const links = [];
    const nodes = [];
    clients.forEach((client, index) => {
      const angle = -Math.PI / 2 + (index / clients.length) * Math.PI * 2;
      const x = centerX + Math.cos(angle) * radiusX;
      const y = centerY + Math.sin(angle) * radiusY;
      const linkClass = client.decision === "selected" ? "network-link active" : "network-link";
      links.push(`<line class="${linkClass}" x1="${centerX}" y1="${centerY}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"></line>`);
      nodes.push(`<g class="network-node ${client.decision}" data-client="${client.id}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)})" tabindex="0" role="button" aria-label="${client.id}, ${client.decision}"><circle r="19"></circle><text y="3">${client.id}</text></g>`);
    });
    svg.innerHTML = links.join("") + nodes.join("");
    $$(".network-node", svg).forEach((node) => {
      const select = () => selectClient(node.dataset.client);
      node.addEventListener("click", select);
      node.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") select();
      });
    });
  }

  function renderClientTable(clients) {
    const body = $("#clientTableBody");
    const decisionText = { selected: "Selected", sleeping: "Sleep", excluded: "Excluded" };
    body.innerHTML = clients
      .slice()
      .sort((a, b) => b.score - a.score)
      .map((client) => `
        <tr data-client="${client.id}" class="${client.id === selectedClientId ? "active" : ""}">
          <td class="client-id">${client.id}</td>
          <td><span class="mini-bar"><i style="width:${(client.trust * 100).toFixed(1)}%"></i></span>${client.trust.toFixed(2)}</td>
          <td>${Math.round(client.energy)} J</td>
          <td>${Math.round(client.drift * 100)}%</td>
          <td><span class="decision-tag ${client.decision}">${decisionText[client.decision]}</span></td>
        </tr>`)
      .join("");
    $$('tr[data-client]', body).forEach((row) => row.addEventListener("click", () => selectClient(row.dataset.client)));
  }

  function selectClient(id) {
    selectedClientId = id;
    const client = currentClients.find((item) => item.id === id) || currentClients[0];
    if (!client) return;
    renderClientTable(currentClients);
    $("#explainClient").textContent = `Client ${client.id.slice(1)}`;
    $("#explainScore").textContent = client.score.toFixed(3);
    const decision = $("#explainDecision");
    decision.className = `decision-pill ${client.decision}`;
    decision.textContent = client.decision === "selected" ? "Selected" : client.decision === "sleeping" ? "Sleep" : "Excluded";

    const labels = { trust: "Trust", energy: "Energy", quality: "Quality", drift: "Drift", latency: "Latency" };
    $("#contributionChart").innerHTML = Object.entries(client.contributions)
      .map(([key, value]) => {
        const width = Math.min(100, Math.abs(value) / 0.45 * 100);
        return `<div class="contribution-row"><span>${labels[key]}</span><div class="contribution-track"><div class="contribution-fill ${value < 0 ? "negative" : ""}" style="width:${width.toFixed(1)}%"></div></div><code>${value >= 0 ? "+" : ""}${value.toFixed(3)}</code></div>`;
      })
      .join("");

    let reason;
    if (client.reason === "low_trust") {
      reason = `Excluded because trust ${client.trust.toFixed(2)} is below the configured gate. The score is still shown for auditability.`;
    } else if (client.reason === "low_energy") {
      reason = `Excluded because ${Math.round(client.energy)} J is below the configured minimum-energy gate.`;
    } else if (client.reason === "selected") {
      reason = "This client meets the active gates and ranks inside the participation budget for the selected policy.";
    } else {
      reason = `Eligible but outside this round’s budget; assigned ${client.sleepRounds} energy-saving sleep round${client.sleepRounds === 1 ? "" : "s"}.`;
    }
    $("#explainReason").textContent = reason;
  }

  function updateScenarioMetrics(controls, clients) {
    const reference = DATA.policies[controls.dataset][controls.policy];
    const selected = clients.filter((client) => client.decision === "selected").length;
    const referenceSelected = Number(reference.final_metrics.selected_clients || 20);
    const referenceRoundEnergy = Number(reference.estimated_energy_j) / 30;
    const referenceRoundComm = Number(reference.communication_bytes) / 30;
    const ratio = referenceSelected ? selected / referenceSelected : 1;
    const modeledEnergy = referenceRoundEnergy * ratio;
    const modeledComm = referenceRoundComm * ratio;
    $("#metricSelected").textContent = `${selected} / 20`;
    $("#metricEnergy").textContent = `${formatNumber(modeledEnergy, 1)} J`;
    $("#metricComm").textContent = bytesLabel(modeledComm);
    $("#metricF1").textContent = Number(reference.final_metrics.f1).toFixed(4);
    $("#stageDataset").textContent = controls.dataset;
    $("#roundNumber").textContent = String(controls.round).padStart(2, "0");
    $("#metricDisclosure").innerHTML = `<span class="status-chip evidence">Recorded reference</span>${policyLabels[controls.policy]} Stage 14 seed-42 F1 is shown as an accepted reference. Energy and communication are scaled model estimates for the current ${selected}-client what-if selection.`;
  }

  function runSimulation(animate = true) {
    const controls = getControls();
    const state = $("#runState");
    if (animate) {
      state.classList.add("running");
      state.innerHTML = "<span></span> Aggregating";
    }
    currentClients = generateClients(controls);
    if (!selectedClientId || !currentClients.some((client) => client.id === selectedClientId)) {
      selectedClientId = currentClients.find((client) => client.decision === "selected")?.id || currentClients[0].id;
    }
    renderNetwork(currentClients);
    renderClientTable(currentClients);
    selectClient(selectedClientId);
    updateScenarioMetrics(controls, currentClients);
    if (animate) {
      window.setTimeout(() => {
        state.classList.remove("running");
        state.innerHTML = "<span></span> Complete";
      }, 850);
    }
  }

  function updateControlLabels() {
    $("#budgetOutput").textContent = `${$("#budgetRange").value}%`;
    $("#trustOutput").textContent = Number($("#trustRange").value).toFixed(2);
    $("#energyOutput").textContent = `${$("#energyRange").value} J`;
    $("#driftOutput").textContent = `${$("#driftRange").value}%`;
    $("#latencyOutput").textContent = `${$("#latencyRange").value} ms`;
    $("#runState").innerHTML = "<span></span> Ready";
  }

  function policyChart(dataset) {
    const policies = DATA.policies[dataset];
    $("#policyChart").innerHTML = Object.entries(policies)
      .map(([name, row]) => {
        const saving = Math.max(0, Number(row.estimated_energy_saving_percent));
        const marker = clamp((Number(row.final_metrics.f1) - 0.94) / 0.06 * 100, 0, 100);
        return `<div class="policy-row"><span class="policy-name">${policyLabels[name]}</span><div class="policy-bars" title="F1 ${Number(row.final_metrics.f1).toFixed(4)} · saving ${saving.toFixed(2)}%"><div class="energy-bar" style="width:${Math.min(100, saving / 50 * 100).toFixed(1)}%"></div><i class="f1-marker" style="left:${marker.toFixed(1)}%"></i></div><span class="policy-value">${saving.toFixed(1)}% / ${Number(row.final_metrics.f1).toFixed(3)}</span></div>`;
      })
      .join("");
  }

  function pathFor(values, x, y) {
    return values.map((value, index) => `${index ? "L" : "M"}${x(index).toFixed(2)},${y(value).toFixed(2)}`).join(" ");
  }

  function roundChart(dataset, policy = "telemetry_heuristic") {
    const rounds = DATA.policies[dataset][policy].rounds;
    const svg = $("#roundTraceChart");
    const width = 640;
    const height = 330;
    const margin = { left: 48, right: 44, top: 24, bottom: 35 };
    const x = (index) => margin.left + index / Math.max(1, rounds.length - 1) * (width - margin.left - margin.right);
    const yF1 = (value) => margin.top + (1 - clamp((value - 0.90) / 0.10, 0, 1)) * (height - margin.top - margin.bottom);
    const yEnergy = (value) => margin.top + (1 - clamp(value / 50, 0, 1)) * (height - margin.top - margin.bottom);
    const grid = [0, 0.25, 0.5, 0.75, 1].map((step) => {
      const y = margin.top + step * (height - margin.top - margin.bottom);
      return `<line class="grid-line" x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}"></line><text class="axis-label" x="8" y="${y + 3}">${(1 - step * .1).toFixed(2)}</text><text class="axis-label" x="${width - 36}" y="${y + 3}">${Math.round((1 - step) * 50)}%</text>`;
    }).join("");
    const xLabels = [0, 9, 19, 29].map((index) => `<text class="axis-label" x="${x(index)}" y="${height - 10}" text-anchor="middle">${index + 1}</text>`).join("");
    svg.innerHTML = `${grid}<line class="axis-line" x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}"></line>${xLabels}<path class="trace-f1" d="${pathFor(rounds.map((row) => Number(row.f1)), x, yF1)}"></path><path class="trace-energy" d="${pathFor(rounds.map((row) => Number(row.energy_saving_percent)), x, yEnergy)}"></path>`;
    $("#roundTraceLabel").textContent = `${dataset} · ${policyLabels[policy].toLowerCase()}`;
  }

  function renderPolicyTable(dataset) {
    const body = $("#policyTableBody");
    body.innerHTML = Object.entries(DATA.policies[dataset]).map(([name, row]) => `
      <tr class="${name === "telemetry_heuristic" ? "highlight" : ""}" data-policy="${name}">
        <td>${policyLabels[name]}</td>
        <td>${Number(row.final_metrics.f1).toFixed(4)}</td>
        <td>${Number(row.final_metrics.accuracy).toFixed(4)}</td>
        <td>${formatNumber(Number(row.estimated_energy_j), 1)} J</td>
        <td>${formatNumber(Number(row.estimated_energy_saving_percent), 2)}%</td>
        <td>${bytesLabel(Number(row.communication_bytes))}</td>
        <td>${formatNumber(Number(row.controller_overhead_seconds) * 1000, 2)} ms</td>
      </tr>`).join("");
    $$('tr[data-policy]', body).forEach((row) => row.addEventListener("click", () => roundChart(dataset, row.dataset.policy)));
  }

  function renderPolicySection(dataset) {
    policyDataset = dataset;
    $$("#policyDatasetTabs button").forEach((button) => button.classList.toggle("active", button.dataset.dataset === dataset));
    policyChart(dataset);
    roundChart(dataset);
    renderPolicyTable(dataset);
  }

  function populateAttackMethods() {
    const dataset = $("#attackDataset").value;
    const methods = [...new Set(DATA.per_attack.filter((row) => row.dataset === dataset).map((row) => row.method))].sort();
    const select = $("#attackMethod");
    const prior = select.value;
    select.innerHTML = methods.map((method) => `<option value="${method}" ${method === "ecotrust_agent" ? "selected" : ""}>${method.replaceAll("_", " ")}</option>`).join("");
    if (methods.includes(prior)) select.value = prior;
    renderRareAttacks();
  }

  function renderRareAttacks() {
    const dataset = $("#attackDataset").value;
    const method = $("#attackMethod").value;
    const supportMax = Number($("#attackSupport").value);
    const sourceRows = DATA.per_attack
      .filter((row) => row.dataset === dataset && row.method === method && row.traffic_type === "attack" && Number(row.support) <= supportMax);
    const grouped = new Map();
    sourceRows.forEach((row) => {
      if (!grouped.has(row.attack_type)) {
        grouped.set(row.attack_type, { attack_type: row.attack_type, support: 0, true_positives: 0, false_negatives: 0, seeds: new Set() });
      }
      const item = grouped.get(row.attack_type);
      item.support += Number(row.support || 0);
      item.true_positives += Number(row.true_positives || 0);
      item.false_negatives += Number(row.false_negatives || 0);
      item.seeds.add(row.seed);
    });
    const rows = [...grouped.values()]
      .map((row) => ({ ...row, seed_count: row.seeds.size, mean_support: row.seeds.size ? row.support / row.seeds.size : 0, recall: row.support ? row.true_positives / row.support : 0 }))
      .sort((a, b) => a.mean_support - b.mean_support || a.recall - b.recall)
      .slice(0, 14);
    $("#rareEmpty").hidden = rows.length > 0;
    $("#rareAttackBody").innerHTML = rows.map((row) => {
      const recall = Number(row.recall || 0);
      return `<tr><td>${row.attack_type}</td><td>${formatNumber(row.mean_support, row.mean_support % 1 ? 1 : 0)}</td><td>${row.seed_count}</td><td>${row.true_positives}</td><td>${row.false_negatives}</td><td><div class="recall-meter"><span><i style="width:${(recall * 100).toFixed(1)}%"></i></span>${(recall * 100).toFixed(1)}%</div></td></tr>`;
    }).join("");
  }

  function renderClaims() {
    $("#claimGrid").innerHTML = DATA.claims.map((row) => {
      const supported = row.status === "supported";
      return `<article class="claim-card ${supported ? "supported" : "unsupported"}"><span>${supported ? "Supported" : "Boundary"}</span><strong>${row.claim}</strong><p>${row.evidence}</p></article>`;
    }).join("");
  }

  function renderDownloads() {
    const preferred = DATA.downloads.filter((item) => !item.file.includes("/manifests/") || /(?:12_|14_|15_)/.test(item.file));
    $("#downloadGrid").innerHTML = preferred.map((item) => {
      const name = item.file.split("/").pop();
      const ext = name.split(".").pop();
      return `<a class="download-card" href="${item.file}" download><span class="download-type">${ext}</span><strong>${name}</strong><span>${bytesLabel(Number(item.bytes))} · SHA-256 tracked</span></a>`;
    }).join("");
  }

  function scenarioPayload() {
    const controls = getControls();
    const reference = DATA.policies[controls.dataset][controls.policy];
    return {
      generated_at: new Date().toISOString(),
      type: "deterministic_what_if_simulation",
      evidence_boundary: DATA.meta.evidence_boundary,
      controls,
      selected_client_ids: currentClients.filter((client) => client.decision === "selected").map((client) => client.id),
      decisions: currentClients.map((client) => ({
        client_id: client.id,
        decision: client.decision,
        reason: client.reason,
        priority_score: Number(client.score.toFixed(6)),
        trust: Number(client.trust.toFixed(6)),
        energy_j: client.energy,
        drift: Number(client.drift.toFixed(6)),
        latency_ms: Number(client.latency.toFixed(3)),
      })),
      recorded_stage14_reference: {
        dataset: controls.dataset,
        policy: controls.policy,
        seed: reference.seed,
        final_metrics: reference.final_metrics,
        estimated_energy_j: reference.estimated_energy_j,
        energy_measurement_type: reference.energy_measurement_type,
      },
      limitations: [
        "Custom controls do not produce a new validated F1 result.",
        "Energy is model-estimated, not directly measured hardware energy.",
        "Per-attack labels are used for binary detection analysis, not multiclass prediction.",
      ],
    };
  }

  function downloadScenario() {
    const blob = new Blob([JSON.stringify(scenarioPayload(), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `ecotrust-scenario-${getControls().dataset.toLowerCase().replaceAll("_", "-")}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  function resetSimulation() {
    $("#datasetSelect").value = "TON_IoT";
    $("#policySelect").value = "telemetry_heuristic";
    $("#budgetRange").value = "60";
    $("#trustRange").value = "0.55";
    $("#energyRange").value = "120";
    $("#driftRange").value = "20";
    $("#latencyRange").value = "250";
    currentRound = 1;
    selectedClientId = null;
    updateControlLabels();
    runSimulation(false);
  }

  $("#simulationForm").addEventListener("submit", (event) => {
    event.preventDefault();
    currentRound = currentRound >= 30 ? 1 : currentRound + 1;
    runSimulation(true);
  });
  $("#resetSimulation").addEventListener("click", resetSimulation);
  $$("#simulationForm input, #simulationForm select").forEach((element) => element.addEventListener("input", updateControlLabels));
  $("#datasetSelect").addEventListener("change", () => { selectedClientId = null; runSimulation(false); });
  $("#policySelect").addEventListener("change", () => runSimulation(false));
  $$("#policyDatasetTabs button").forEach((button) => button.addEventListener("click", () => renderPolicySection(button.dataset.dataset)));
  $("#attackDataset").addEventListener("change", populateAttackMethods);
  $("#attackMethod").addEventListener("change", renderRareAttacks);
  $("#attackSupport").addEventListener("change", renderRareAttacks);
  $("#downloadScenario").addEventListener("click", downloadScenario);
  $("#downloadScenarioTop").addEventListener("click", downloadScenario);

  updateControlLabels();
  runSimulation(false);
  renderPolicySection(policyDataset);
  populateAttackMethods();
  renderClaims();
  renderDownloads();
})();
