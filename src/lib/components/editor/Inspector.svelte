<script lang="ts">
	import { display, parseDisplay } from '$lib/core/units.js';
	import type { Side, MachineSettings, StockSettings } from '$lib/core/design/types.js';
	import type {
		PackagingData,
		Pocket,
		Support,
		SupportAnchor,
		SupportMount
	} from '$lib/features/packaging/types.js';
	import { CUTOUT_PRESETS, SUPPORT_PRESETS } from '$lib/features/packaging/presets.js';
	import { canSpanToDeck } from '$lib/features/packaging/levels.js';
	import { supportHasAncestor } from '$lib/features/packaging/mounting.js';
	import CollapsiblePanel from './CollapsiblePanel.svelte';
	import type { EditorState } from '$lib/editor/state.svelte.js';

	let { editor }: { editor: EditorState } = $props();

	const design = $derived(editor.design);
	/** The active sheet as packaging sees it: deck, perimeter, pockets, supports. */
	const packaging = $derived(editor.packaging);
	/** The profile the active sheet is cut on; the Machine panel edits it. */
	const machine = $derived(editor.machine);
	const sheetName = $derived(
		design.sheets.find((sheet) => sheet.id === design.activeSheetId)?.name ?? 'sheet'
	);
	const units = $derived(design.stock.units);
	const pocket = $derived(packaging.pockets.find((p) => p.id === editor.selectedPocketId));
	const support = $derived(packaging.supports.find((r) => r.id === editor.selectedSupportId));
	const SIDES: readonly Side[] = ['top', 'right', 'bottom', 'left'];

	const unitLabel = $derived(units === 'in' ? 'in' : 'mm');
	const mm = (value: number) => display(value, units);

	type NumericKey<T> = { [K in keyof T]: T[K] extends number ? K : never }[keyof T];

	function setStock(key: NumericKey<StockSettings>, raw: string): void {
		const value = parseDisplay(raw, units);
		if (Number.isFinite(value)) editor.setStock(key, value);
	}
	function setPackaging(key: NumericKey<PackagingData>, raw: string): void {
		const value = parseDisplay(raw, units);
		if (Number.isFinite(value)) editor.setPackaging(key, value);
	}
	function setPocket(key: keyof Pocket, raw: string): void {
		if (!pocket) return;
		const value = parseDisplay(raw, units);
		if (Number.isFinite(value)) editor.updatePocket(pocket.id, { [key]: value });
	}
	/** Writes a machine setting onto the profile the active sheet is cut on. */
	function setMachine(key: keyof MachineSettings, raw: string): void {
		const value = parseDisplay(raw, units);
		if (Number.isFinite(value)) editor.setMachineSetting(key, value as never);
	}
	function setSupport(key: keyof Support, raw: string): void {
		if (!support) return;
		const value = parseDisplay(raw, units);
		if (Number.isFinite(value)) editor.resizeSupport(support.id, { [key]: value });
	}

	/**
	 * The anchors this support may use. A tray is always slung under the deck,
	 * and a support cannot stand on itself or on anything standing on it.
	 */
	const anchorOptions = $derived.by((): { value: string; label: string }[] => {
		if (!support) return [];
		if (support.kind === 'tray') return [{ value: 'deck-underside', label: 'Underside of deck' }];
		return [
			{ value: 'box-floor', label: 'Box floor' },
			{ value: 'deck-top', label: 'Top of deck' },
			{ value: 'deck-underside', label: 'Underside of deck' },
			...packaging.supports
				.filter(
					(candidate) =>
						candidate.id !== support.id &&
						candidate.kind !== 'tray' &&
						!supportHasAncestor(candidate, support.id, packaging.supports)
				)
				.map((candidate) => ({
					value: `support:${candidate.id}`,
					label: `Top of ${candidate.name}`
				}))
		];
	});

	/** The select's value for the mount this support actually has. */
	const anchorValue = $derived(
		!support
			? ''
			: support.mount.anchor === 'support-top'
				? `support:${support.mount.supportId}`
				: support.mount.anchor
	);

	function setAnchor(raw: string): void {
		if (!support) return;
		const { offset } = support.mount;
		const mount: SupportMount = raw.startsWith('support:')
			? { anchor: 'support-top', supportId: raw.slice('support:'.length), offset }
			: { anchor: raw as Exclude<SupportAnchor, 'support-top'>, offset };
		// A height that can no longer span falls back to the height it had, so
		// the part never silently collapses to nothing.
		const heightMode: Support['heightMode'] =
			support.heightMode === 'span' && !canSpanToDeck({ ...support, mount }, editor.packaging)
				? 'fixed'
				: support.heightMode;
		editor.updateSupport(support.id, { mount, heightMode });
	}

	function setMountOffset(raw: string): void {
		if (!support) return;
		const offset = parseDisplay(raw, units);
		if (!Number.isFinite(offset)) return;
		editor.updateSupport(support.id, { mount: { ...support.mount, offset } });
	}

	function setHeightMode(mode: Support['heightMode']): void {
		if (!support) return;
		// Switching to a fixed height keeps the height it is showing, so the
		// part does not jump when the operator takes manual control.
		editor.updateSupport(support.id, { heightMode: mode, h: support.h });
	}

	const purposeLabel = (value: Pocket['purpose']) =>
		value === 'product'
			? 'Product opening'
			: value === 'imported'
				? 'Imported profile'
				: (CUTOUT_PRESETS.find((preset) => preset.id === value)?.label ?? value);

	const supportLabel = (item: Support) =>
		item.kind === 'tray'
			? 'Recessed tray'
			: item.kind === 'platform'
				? 'Platform step'
				: item.cornerClosure === 'lock'
					? 'Locking riser box'
					: 'Glued riser box';
</script>

<aside class="sidebar">
	<header class="brand">
		<p class="brand-eyebrow">VOISEE</p>
		<h1>Insert generator <span>drag-knife CAM</span></h1>
	</header>

	<CollapsiblePanel title="Material">
		<div class="form-grid">
			<label class="field">
				Thickness ({unitLabel})
				<input
					type="number"
					step="0.001"
					value={mm(design.stock.material)}
					oninput={(e) => setStock('material', e.currentTarget.value)}
				/>
			</label>
			<label class="field">
				Minimum web ({unitLabel})
				<input
					type="number"
					step="0.001"
					value={mm(design.stock.minimumWeb)}
					oninput={(e) => setStock('minimumWeb', e.currentTarget.value)}
				/>
			</label>
			<label class="field wide">
				Board appearance
				<select
					value={design.stock.boardFinish}
					onchange={(e) =>
						editor.setStock('boardFinish', e.currentTarget.value as StockSettings['boardFinish'])}
				>
					<option value="kraft">Natural kraft</option>
					<option value="white">White board</option>
					<option value="printed">Printed</option>
				</select>
			</label>
			<label class="field wide">
				Grain / flute direction
				<select
					value={design.stock.grainDirection}
					onchange={(e) =>
						editor.setStock(
							'grainDirection',
							e.currentTarget.value as StockSettings['grainDirection']
						)}
				>
					<option value="y">Along Y</option>
					<option value="x">Along X</option>
					<option value="unknown">Unspecified</option>
				</select>
			</label>
			<label class="field wide">
				Fold allowance
				<select
					value={packaging.foldCompensation}
					onchange={(e) =>
						editor.setPackaging(
							'foldCompensation',
							e.currentTarget.value as PackagingData['foldCompensation']
						)}
				>
					<option value="none">None (cut to drawn size)</option>
					<option value="computed">Computed from radius and K factor</option>
					<option value="manual">Measured deduction</option>
				</select>
			</label>
			{#if packaging.foldCompensation === 'manual'}
				<label class="field wide">
					Deduction per fold ({unitLabel})
					<input
						type="number"
						step="0.001"
						value={mm(packaging.foldDeduction)}
						oninput={(e) => setPackaging('foldDeduction', e.currentTarget.value)}
					/>
				</label>
			{/if}
			{#if packaging.foldCompensation === 'computed'}
				<label class="field">
					Radius factor
					<input
						type="number"
						step="0.05"
						value={packaging.foldRadiusFactor}
						oninput={(e) => editor.setPackaging('foldRadiusFactor', Number(e.currentTarget.value))}
					/>
				</label>
				<label class="field">
					K factor
					<input
						type="number"
						step="0.05"
						value={packaging.foldKFactor}
						oninput={(e) => editor.setPackaging('foldKFactor', Number(e.currentTarget.value))}
					/>
				</label>
			{/if}
		</div>
		<p class="help">
			Grain direction and thickness are recorded in the G-code header. Fold allowance shrinks each
			folded panel so the assembled part lands on its drawn size.
		</p>
	</CollapsiblePanel>

	<CollapsiblePanel title="Machine">
		<p class="help">
			These settings belong to the <strong>{machine.name}</strong> profile, which
			{sheetName} is cut on. Sheets sharing this profile change with it.
		</p>
		<div class="form-grid">
			<label class="field wide">
				Profile name
				<input
					type="text"
					value={machine.name}
					oninput={(e) => editor.renameMachineProfile(e.currentTarget.value)}
				/>
			</label>
			<label class="field">
				Units
				<select
					value={design.stock.units}
					onchange={(e) =>
						editor.setStock('units', e.currentTarget.value as StockSettings['units'])}
				>
					<option value="in">Inches</option>
					<option value="mm">Millimeters</option>
				</select>
			</label>
			<label class="field">
				Fabrication
				<select
					value={machine.fabricationMode}
					onchange={(e) =>
						editor.setMachineSetting(
							'fabricationMode',
							e.currentTarget.value as MachineSettings['fabricationMode']
						)}
				>
					<option value="knife">Drag knife</option>
					<option value="router">Router</option>
				</select>
			</label>
			<label class="field">
				Safe Z ({unitLabel})
				<input
					type="number"
					step="0.001"
					value={mm(machine.safeZ)}
					oninput={(e) => setMachine('safeZ', e.currentTarget.value)}
				/>
			</label>
			<label class="field">
				Cut depth ({unitLabel})
				<input
					type="number"
					step="0.001"
					value={mm(machine.cutDepth)}
					oninput={(e) => setMachine('cutDepth', e.currentTarget.value)}
				/>
			</label>
			<label class="field">
				Score depth ({unitLabel})
				<input
					type="number"
					step="0.001"
					value={mm(machine.scoreDepth)}
					oninput={(e) => setMachine('scoreDepth', e.currentTarget.value)}
				/>
			</label>
			<label class="field">
				Blade offset ({unitLabel})
				<input
					type="number"
					step="0.001"
					value={mm(machine.bladeOffset)}
					oninput={(e) => setMachine('bladeOffset', e.currentTarget.value)}
				/>
			</label>
			<label class="field">
				Overcut ({unitLabel})
				<input
					type="number"
					step="0.001"
					value={mm(machine.overcut)}
					oninput={(e) => setMachine('overcut', e.currentTarget.value)}
				/>
			</label>
			{#if machine.fabricationMode === 'router'}
				<label class="field">
					Bit diameter ({unitLabel})
					<input
						type="number"
						step="0.001"
						value={mm(machine.bitWidth)}
						oninput={(e) => setMachine('bitWidth', e.currentTarget.value)}
					/>
				</label>
			{/if}
		</div>
	</CollapsiblePanel>

	{#if pocket}
		<section class="panel">
			<div class="panel-head">
				<h2>{pocket.name}</h2>
				<button class="link danger" onclick={() => editor.removePocket(pocket.id)}>Delete</button>
			</div>
			<p class="badge">{purposeLabel(pocket.purpose)}</p>

			<div class="form-grid">
				<label class="field wide">
					Name
					<input
						value={pocket.name}
						oninput={(e) => editor.updatePocket(pocket.id, { name: e.currentTarget.value })}
					/>
				</label>
				<label class="field wide">
					Opening type
					<select
						value={pocket.purpose}
						onchange={(e) =>
							editor.updatePocket(pocket.id, {
								purpose: e.currentTarget.value as Pocket['purpose']
							})}
					>
						<option value="product">Product opening</option>
						{#each CUTOUT_PRESETS.filter((p) => p.id !== 'rectangle' && p.id !== 'folded') as preset (preset.id)}
							<option value={preset.id}>{preset.label}</option>
						{/each}
						<option value="imported">Imported profile</option>
					</select>
				</label>
				<label class="field wide">
					Shape
					<select
						value={pocket.shape}
						onchange={(e) =>
							editor.updatePocket(pocket.id, { shape: e.currentTarget.value as Pocket['shape'] })}
					>
						<option value="rectangle">Rectangle</option>
						<option value="rounded">Rounded rectangle</option>
						<option value="ellipse">Ellipse</option>
						{#if pocket.shape === 'profile'}<option value="profile">Imported profile</option>{/if}
					</select>
				</label>

				<label class="field">
					X from left ({unitLabel})
					<input
						type="number"
						step="0.001"
						value={mm(pocket.x)}
						oninput={(e) => setPocket('x', e.currentTarget.value)}
					/>
				</label>
				<label class="field">
					Y from bottom ({unitLabel})
					<input
						type="number"
						step="0.001"
						value={mm(pocket.y)}
						oninput={(e) => setPocket('y', e.currentTarget.value)}
					/>
				</label>
				<label class="field">
					Width ({unitLabel})
					<input
						type="number"
						step="0.001"
						value={mm(pocket.w)}
						oninput={(e) => setPocket('w', e.currentTarget.value)}
					/>
				</label>
				<label class="field">
					Height ({unitLabel})
					<input
						type="number"
						step="0.001"
						value={mm(pocket.h)}
						oninput={(e) => setPocket('h', e.currentTarget.value)}
					/>
				</label>
				{#if pocket.shape === 'rounded'}
					<label class="field">
						Corner radius ({unitLabel})
						<input
							type="number"
							step="0.001"
							value={mm(pocket.cornerRadius)}
							oninput={(e) => setPocket('cornerRadius', e.currentTarget.value)}
						/>
					</label>
				{/if}
			</div>

			{#if pocket.shape === 'rectangle'}
				<p class="field-label">Walls</p>
				<div class="checkrow">
					{#each SIDES as side (side)}
						<label class="check" class:on={pocket.sides[side]}>
							<input
								type="checkbox"
								checked={pocket.sides[side]}
								onchange={(e) =>
									editor.updatePocket(pocket.id, {
										sides: { ...pocket.sides, [side]: e.currentTarget.checked }
									})}
							/>
							{side}
						</label>
					{/each}
				</div>

				<div class="form-grid" style="margin-top: 10px">
					<label class="field">
						Wall depth ({unitLabel})
						<input
							type="number"
							step="0.001"
							value={mm(pocket.wallDepth)}
							oninput={(e) => setPocket('wallDepth', e.currentTarget.value)}
						/>
					</label>
					<label class="field">
						Corner relief ({unitLabel})
						<input
							type="number"
							step="0.001"
							value={mm(pocket.relief)}
							oninput={(e) => setPocket('relief', e.currentTarget.value)}
						/>
					</label>
					<label class="field">
						Glue flange
						<select
							value={pocket.flangeEnabled ? 'yes' : 'no'}
							onchange={(e) =>
								editor.updatePocket(pocket.id, { flangeEnabled: e.currentTarget.value === 'yes' })}
						>
							<option value="yes">Enabled</option>
							<option value="no">Disabled</option>
						</select>
					</label>
					{#if pocket.flangeEnabled}
						<label class="field">
							Flange ({unitLabel})
							<input
								type="number"
								step="0.001"
								value={mm(pocket.flange)}
								oninput={(e) => setPocket('flange', e.currentTarget.value)}
							/>
						</label>
					{/if}
				</div>

				<p class="field-label">Finger pulls</p>
				<div class="checkrow">
					{#each SIDES as side (side)}
						<label class="check" class:on={pocket.pulls[side]}>
							<input
								type="checkbox"
								checked={pocket.pulls[side]}
								onchange={(e) =>
									editor.updatePocket(pocket.id, {
										pulls: { ...pocket.pulls, [side]: e.currentTarget.checked }
									})}
							/>
							{side}
						</label>
					{/each}
				</div>
				{#if SIDES.some((side) => pocket.pulls[side])}
					<div class="form-grid" style="margin-top: 10px">
						<label class="field">
							Pull diameter ({unitLabel})
							<input
								type="number"
								step="0.001"
								value={mm(pocket.pullDiameter)}
								oninput={(e) => setPocket('pullDiameter', e.currentTarget.value)}
							/>
						</label>
						<label class="field">
							Wall reach ({unitLabel})
							<input
								type="number"
								step="0.001"
								value={mm(pocket.pullDepth)}
								oninput={(e) => setPocket('pullDepth', e.currentTarget.value)}
							/>
						</label>
					</div>
				{/if}

				<p class="help">
					Draw the finished top opening, then refine its dimensions here. Walls and flanges are
					generated inward. Corner relief slots let adjacent walls fold without colliding.
				</p>
			{/if}
		</section>
	{:else if support}
		<section class="panel">
			<div class="panel-head">
				<h2>{support.name}</h2>
				<button class="link danger" onclick={() => editor.removeSupport(support.id)}>Delete</button>
			</div>
			<p class="badge">{supportLabel(support)}</p>

			<div class="form-grid">
				<label class="field wide">
					Name
					<input
						value={support.name}
						oninput={(e) => editor.updateSupport(support.id, { name: e.currentTarget.value })}
					/>
				</label>
				<label class="field wide">
					Support type
					<select
						value={support.kind}
						onchange={(e) =>
							editor.updateSupport(support.id, { kind: e.currentTarget.value as Support['kind'] })}
					>
						{#each SUPPORT_PRESETS as preset (preset.id)}
							{#if preset.id !== 'riser-lock'}
								<option value={preset.id === 'riser-glue' ? 'riser' : preset.id}>
									{preset.id === 'riser-glue' ? 'Riser box' : preset.label}
								</option>
							{/if}
						{/each}
					</select>
				</label>
				<label class="field">
					Width ({unitLabel})
					<input
						type="number"
						step="0.001"
						value={mm(support.w)}
						oninput={(e) => setSupport('w', e.currentTarget.value)}
					/>
				</label>
				<label class="field">
					Depth ({unitLabel})
					<input
						type="number"
						step="0.001"
						value={mm(support.d)}
						oninput={(e) => setSupport('d', e.currentTarget.value)}
					/>
				</label>
				<label class="field">
					Height ({unitLabel})
					<input
						type="number"
						step="0.001"
						value={mm(support.h)}
						readonly={support.heightMode === 'span'}
						title={support.heightMode === 'span'
							? 'Derived from the gap up to the deck underside'
							: undefined}
						oninput={(e) => setSupport('h', e.currentTarget.value)}
					/>
				</label>
				<label class="field">
					Glue flange ({unitLabel})
					<input
						type="number"
						step="0.001"
						value={mm(support.flange)}
						oninput={(e) => setSupport('flange', e.currentTarget.value)}
					/>
				</label>
				<label class="field wide">
					Cutting sheet
					<select
						value={support.sheetId}
						onchange={(e) => editor.resizeSupport(support.id, { sheetId: e.currentTarget.value })}
					>
						{#each design.sheets as sheet (sheet.id)}
							<option value={sheet.id}>{sheet.name}</option>
						{/each}
					</select>
				</label>

				<label class="field wide">
					Assembly mount
					<select
						value={anchorValue}
						disabled={support.kind === 'tray'}
						title={support.kind === 'tray'
							? 'A recessed tray always hangs under the deck'
							: 'The surface this part is built from'}
						onchange={(e) => setAnchor(e.currentTarget.value)}
					>
						{#each anchorOptions as option (option.value)}
							<option value={option.value}>{option.label}</option>
						{/each}
					</select>
				</label>
				<label class="field">
					Mount offset ({unitLabel})
					<input
						type="number"
						step="0.001"
						value={mm(support.mount.offset)}
						title="Distance away from the mounting surface"
						oninput={(e) => setMountOffset(e.currentTarget.value)}
					/>
				</label>
				{#if support.kind !== 'tray'}
					<label class="field">
						Height from
						<select
							value={support.heightMode}
							onchange={(e) => setHeightMode(e.currentTarget.value as Support['heightMode'])}
						>
							<option value="fixed">Fixed height</option>
							<option value="span" disabled={!canSpanToDeck(support, editor.packaging)}>
								Spans to deck
							</option>
						</select>
					</label>
				{/if}

				{#if support.kind === 'tray'}
					<label class="field">
						Deck overlap ({unitLabel})
						<input
							type="number"
							step="0.001"
							value={mm(support.overlap)}
							oninput={(e) => setSupport('overlap', e.currentTarget.value)}
						/>
					</label>
					<label class="field">
						Wall taper ({unitLabel})
						<input
							type="number"
							step="0.001"
							value={mm(support.taper)}
							oninput={(e) => setSupport('taper', e.currentTarget.value)}
						/>
					</label>
					<label class="field wide">
						Open side
						<select
							value={support.openSide}
							onchange={(e) =>
								editor.updateSupport(support.id, {
									openSide: e.currentTarget.value as Support['openSide']
								})}
						>
							<option value="none">Closed on all sides</option>
							{#each SIDES as side (side)}<option value={side}>{side}</option>{/each}
						</select>
					</label>
				{:else}
					<label class="field">
						Corner seam ({unitLabel})
						<input
							type="number"
							step="0.001"
							value={mm(support.seam)}
							oninput={(e) => setSupport('seam', e.currentTarget.value)}
						/>
					</label>
					<label class="field">
						Corner closure
						<select
							value={support.cornerClosure}
							onchange={(e) =>
								editor.updateSupport(support.id, {
									cornerClosure: e.currentTarget.value as Support['cornerClosure']
								})}
						>
							<option value="glue">Glue tabs</option>
							<option value="lock">Locking tabs</option>
						</select>
					</label>
					<label class="field wide">
						Bottom flange
						<select
							value={support.bottomFlange ? 'yes' : 'no'}
							onchange={(e) =>
								editor.updateSupport(support.id, { bottomFlange: e.currentTarget.value === 'yes' })}
						>
							<option value="yes">Enabled</option>
							<option value="no">Disabled</option>
						</select>
					</label>
				{/if}
			</div>

			<p class="field-label">Finger pulls</p>
			<div class="checkrow">
				{#each SIDES as side (side)}
					<label class="check" class:on={support.pulls[side]}>
						<input
							type="checkbox"
							checked={support.pulls[side]}
							onchange={(e) =>
								editor.updateSupport(support.id, {
									pulls: { ...support.pulls, [side]: e.currentTarget.checked }
								})}
						/>
						{side}
					</label>
				{/each}
			</div>
		</section>
	{:else}
		<section class="panel">
			<h2>Stock and top deck</h2>
			<div class="form-grid">
				<label class="field">
					Deck X ({unitLabel})
					<input
						type="number"
						step="0.001"
						value={mm(packaging.deckX)}
						oninput={(e) => setPackaging('deckX', e.currentTarget.value)}
					/>
				</label>
				<label class="field">
					Deck Y ({unitLabel})
					<input
						type="number"
						step="0.001"
						value={mm(packaging.deckY)}
						oninput={(e) => setPackaging('deckY', e.currentTarget.value)}
					/>
				</label>
				<label class="field">
					Deck width ({unitLabel})
					<input
						type="number"
						step="0.001"
						value={mm(packaging.deckW)}
						oninput={(e) => setPackaging('deckW', e.currentTarget.value)}
					/>
				</label>
				<label class="field">
					Deck height ({unitLabel})
					<input
						type="number"
						step="0.001"
						value={mm(packaging.deckH)}
						oninput={(e) => setPackaging('deckH', e.currentTarget.value)}
					/>
				</label>
				<label class="field wide">
					Perimeter
					<select
						value={packaging.perimeterType}
						onchange={(e) =>
							editor.setPackaging(
								'perimeterType',
								e.currentTarget.value as PackagingData['perimeterType']
							)}
					>
						<option value="folded">Walls with inward glue flanges</option>
						<option value="joist">Rolled edge joists</option>
						<option value="plain">Plain through cut</option>
					</select>
				</label>
				{#if packaging.perimeterType === 'folded'}
					<label class="field">
						Wall ({unitLabel})
						<input
							type="number"
							step="0.001"
							value={mm(packaging.perimeterWall)}
							oninput={(e) => setPackaging('perimeterWall', e.currentTarget.value)}
						/>
					</label>
					<label class="field">
						Flange ({unitLabel})
						<input
							type="number"
							step="0.001"
							value={mm(packaging.perimeterFlange)}
							oninput={(e) => setPackaging('perimeterFlange', e.currentTarget.value)}
						/>
					</label>
					<label class="field">
						Corner relief ({unitLabel})
						<input
							type="number"
							step="0.001"
							value={mm(packaging.perimeterRelief)}
							oninput={(e) => setPackaging('perimeterRelief', e.currentTarget.value)}
						/>
					</label>
				{/if}
				{#if packaging.perimeterType === 'joist'}
					<label class="field">
						Joist axis
						<select
							value={packaging.joistAxis}
							onchange={(e) =>
								editor.setPackaging(
									'joistAxis',
									e.currentTarget.value as PackagingData['joistAxis']
								)}
						>
							<option value="vertical">Left and right</option>
							<option value="horizontal">Top and bottom</option>
						</select>
					</label>
					<label class="field">
						Folds
						<input
							type="number"
							min="1"
							max="5"
							step="1"
							value={packaging.joistFolds}
							oninput={(e) => editor.setPackaging('joistFolds', Number(e.currentTarget.value))}
						/>
					</label>
					<label class="field">
						Joist height ({unitLabel})
						<input
							type="number"
							step="0.001"
							value={mm(packaging.joistHeight)}
							oninput={(e) => setPackaging('joistHeight', e.currentTarget.value)}
						/>
					</label>
					<label class="field">
						Joist depth ({unitLabel})
						<input
							type="number"
							step="0.001"
							value={mm(packaging.joistDepth)}
							oninput={(e) => setPackaging('joistDepth', e.currentTarget.value)}
						/>
					</label>
				{/if}
			</div>
			<p class="help">
				Drag the deck or its edge grips on the canvas, or type exact dimensions here. Select an
				opening or support to edit it.
			</p>
		</section>
	{/if}
</aside>
