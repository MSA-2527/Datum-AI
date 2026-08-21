import { useModel } from '../modelStore';
import { SPOT_WELD, type BarRackDesign } from '../domain/barRack';

/**
 * The rack's numbers, beside the rack.
 *
 * A rack drawing on its own is not the deliverable. What the plating engineer signs off is
 * the current, the time, the cooling load and the contact sizing — the geometry is the
 * consequence of those, not the other way round. So the figures are shown next to the model
 * with the reasoning attached, in the order the physics imposes: what the part is, what it
 * draws, what the rack has to be to carry it, and what has to be true for the batch to be
 * good.
 *
 * Every check states the measurement and the limit rather than a verdict, because most of
 * them are trades somebody may legitimately decide to make.
 */
export function RackPanel() {
  const design = useModel((s) => s.rackDesign);
  const bar = useModel((s) => s.barRackDesign);

  // The bar rack is a different rack, not a variant, so it gets its own reading.
  if (bar) return <BarRackReading design={bar} />;
  if (!design) return null;

  const { part, process, material, electrical, rack } = design;
  const blockers = design.checks.filter((c) => !c.ok && c.severity === 'blocker');

  return (
    <details className="rk" open>
      <summary>
        Rack sizing
        {blockers.length > 0 && <span className="rk-flag">{blockers.length}</span>}
      </summary>

      <div className="rk-body">
        <div className="rk-group">
          <strong>The part</strong>
          <Row k="Area" v={`${part.areaDm2.toFixed(2)} dm²`} note="Measured off the solid, not the envelope." />
          <Row k="Volume" v={`${(part.volumeMm3 / 1000).toFixed(1)} cm³`} />
          <Row k="Mass" v={grams(part.massG)} />
          <Row k="Size" v={part.sizeMm.map((d) => d.toFixed(0)).join(' × ') + ' mm'} />
        </div>

        <div className="rk-group">
          <strong>The process</strong>
          <Row k="Type" v={process.label} note={process.basis} />
          <Row k="Density" v={`${process.currentDensityAdm2} A/dm²`} />
          <Row k="Bath" v={`${process.bathC} °C`} />
          <Row k="Coating" v={`${design.thicknessUm.toFixed(0)} µm`} />
          <Row k="Time" v={`${electrical.minutes.toFixed(0)} min`} />
        </div>

        <div className="rk-group">
          <strong>Current</strong>
          <Row k="Per part" v={`${electrical.perPartA.toFixed(2)} A`} />
          <Row k="Total" v={`${electrical.currentA.toFixed(0)} A at ${electrical.volts} V`} />
          <Row k="Power" v={`${(electrical.powerW / 1000).toFixed(1)} kW`} />
        </div>

        <div className="rk-group">
          <strong>The rack</strong>
          <Row k="Load" v={`${rack.partsTotal} parts — ${rack.partsPerTier} × ${rack.tiers} tiers`} />
          <Row k="Material" v={material.name} note={material.basis} />
          <Row k="Spine" v={`${rack.spineWidthMm} × ${rack.spineThicknessMm} mm`} />
          <Row k="Arms" v={`${rack.armWidthMm} × ${rack.armThicknessMm} mm, ${rack.armLengthMm} mm each side`} />
          <Row k="Contacts" v={`${rack.tipsPerPart} per part, ⌀${rack.tipDiaMm} mm`} />
          <Row k="Hook" v={`⌀${rack.hookDiaMm} mm`} />
          <Row k="Pitch" v={`${rack.pitchMm} mm`} note="Set by solution flow, not by packing." />
        </div>

        <div className="rk-group">
          <strong>Cooling and life</strong>
          <Row k="Heat" v={`${(design.coolingWatts / 1000).toFixed(1)} kW`} />
          <Row k="Circulation" v={`${design.coolingLitresPerMin.toFixed(0)} L/min`} note="At a 3 °C rise across the load." />
          <Row k="Rack life" v={`${design.rackLifeRuns} run${design.rackLifeRuns === 1 ? '' : 's'} before stripping`} />
        </div>

        <div className="rk-group">
          <strong>Quality control</strong>
          <ul className="rk-checks">
            {design.checks.map((check) => (
              <li key={check.id} data-ok={check.ok ? 'true' : 'false'} data-severity={check.severity}>
                <span className="rk-check-title">{check.title}</span>
                <span className="rk-check-detail">{check.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </details>
  );
}

/**
 * The bar-and-clip rack, read out.
 *
 * The order is the order the shop asks in: what is on the bar, what holds it, what it draws,
 * and what has to be true for the batch to come out. Every part number is stated, because a
 * rack is made from stock this shop already keeps and the numbers are how it is ordered.
 */
function BarRackReading({ design }: { design: BarRackDesign }) {
  const blockers = design.checks.filter((c) => !c.ok && c.severity === 'blocker');
  const [down, across, through] = design.part.sizeMm;

  return (
    <details className="rk" open>
      <summary>
        Rack sizing
        {blockers.length > 0 && <span className="rk-flag">{blockers.length}</span>}
      </summary>

      <div className="rk-body">
        <div className="rk-group">
          <strong>The part</strong>
          <Row k="Area" v={`${design.part.areaDm2.toFixed(2)} dm²`} note="Measured off the solid, not the envelope." />
          <Row k="Mass" v={grams(design.part.massG)} />
          <Row
            k="Size"
            v={`${down.toFixed(0)} × ${across.toFixed(0)} × ${through.toFixed(0)} mm`}
            note="It hangs edge-on: only the smallest dimension takes room along the bar."
          />
        </div>

        <div className="rk-group">
          <strong>The bar</strong>
          <Row k="Part number" v={design.bar.partNumber} note={design.bar.description} />
          <Row k="Material" v={design.bar.material} />
          <Row k="Length" v={`${design.bar.lengthMm} mm`} note={`${design.bar.usableSpanMm} mm usable span`} />
          <Row k="Stations" v={`${design.stations} across, ${design.partsTotal} parts`} />
          <Row
            k="Pitch"
            v={`${design.pitchMm.toFixed(1)} mm`}
            note={`${design.clearanceMm.toFixed(1)} mm clear between parts — set by solution flow, not by packing.`}
          />
        </div>

        <div className="rk-group">
          <strong>The clip</strong>
          <Row k="Material" v={`${design.clip.material}, ${design.clip.thicknessMm} mm strip`} />
          <Row k="Grip" v={`${design.clip.gripMm.toFixed(2)} mm`} />
          <Row k="Size" v={`${design.clip.widthMm.toFixed(1)} mm wide, ${design.clip.reachMm.toFixed(0)} mm reach`} />
          <Row k="Welds" v={`${design.clip.spotWelds} per clip, ⌀${SPOT_WELD.diameterMm} mm`} />
        </div>

        <div className="rk-group">
          <strong>The run</strong>
          <Row k="Process" v={design.process.label} note={design.process.basis} />
          <Row k="Coating" v={`${design.thicknessUm.toFixed(0)} µm in ${design.electrical.minutes.toFixed(0)} min`} />
          <Row k="Current" v={`${design.electrical.currentA.toFixed(1)} A at ${design.process.currentDensityAdm2} A/dm²`} />
          <Row
            k="On the rack"
            v={`${(design.rackCurrentFraction * 100).toFixed(0)}%`}
            note="Share of the current coating rack rather than work. Paid for, then stripped off."
          />
          <Row k="Rack mass" v={grams(design.massG)} />
        </div>

        <div className="rk-group">
          <strong>Quality control</strong>
          <ul className="rk-checks">
            {design.checks.map((check) => (
              <li key={check.id} data-ok={check.ok ? 'true' : 'false'} data-severity={check.severity}>
                <span className="rk-check-title">{check.title}</span>
                <span className="rk-check-detail">{check.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </details>
  );
}

function Row({ k, v, note }: { k: string; v: string; note?: string }) {
  return (
    <div className="rk-row" title={note}>
      <span>{k}</span>
      <strong>{v}</strong>
    </div>
  );
}

function grams(g: number): string {
  if (g >= 1e6) return `${(g / 1e6).toFixed(2)} t`;
  if (g >= 1000) return `${(g / 1000).toFixed(2)} kg`;
  return `${g.toFixed(g < 10 ? 1 : 0)} g`;
}
