import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse } from 'acorn';

// Exercise the actual inline functions without a browser or a second CAM implementation.
const html = readFileSync(new URL('./insert-generator.html', import.meta.url), 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const body = parse(source, { ecmaVersion: 'latest' }).body[0].expression.callee.body.body;
function runtime() {
	const context = vm.createContext({});
	const declarations = body.filter(
		(n) =>
			n.type === 'FunctionDeclaration' ||
			(n.type === 'VariableDeclaration' &&
				n.kind === 'const' &&
				n.start < source.indexOf('let state ='))
	);
	vm.runInContext(
		declarations.map((n) => source.slice(n.start, n.end)).join('\n') + '\nlet state = defaults();',
		context
	);
	return (code) => vm.runInContext(code, context);
}

test('knife simulation follows rounded export, scores before cuts, retracts and returns home', () => {
	const run = runtime();
	assert.equal(run('validate().length'), 0);
	assert.equal(run('gcode().includes("M3")'), false);
	assert.equal(
		run('simulationMoves(gcode()).every(m => Number.isFinite(m.end) && m.end > m.start)'),
		true
	);
	assert.equal(
		run('JSON.stringify(simulationMoves(gcode()).at(-1).b)'),
		JSON.stringify({ x: 0, y: 0, z: 3 })
	);
	assert.equal(run('simulationMoves(gcode()).find(m => m.type !== "travel").type'), 'score-down');
	assert.equal(run('simulationMoves(gcode()).some(m => m.b.z === -state.cutDepth)'), true);
});
test('simulator preserves fold direction and separate operation programs', () => {
	const run = runtime();
	run(`var foldPath = line(point(10,10),point(30,10),'score',{foldDirection:'up'});
    var downPath = line(point(10,20),point(30,20),'score',{foldDirection:'down'});
    var cutPath = line(point(40,10),point(60,10),'cut');
    var originalGeometry = allGeometry;
    allGeometry = () => ({paths:[foldPath,downPath,cutPath],tabs:[]});`);
	assert.equal(run("simulationMoves(gcode('crease')).some(m => m.type === 'score-up')"), true);
	assert.equal(run("gcode('crease').includes(': cut')"), false);
	assert.equal(run("gcode('crease').includes('[down]')"), false);
	assert.equal(run("gcode('cut').includes('[down]')"), true);
	assert.equal(run("gcode('cut').includes('[up]')"), false);
	assert.equal(run("simulationMoves(gcode('cut')).some(m => m.type === 'score-down')"), true);
	run('state.scoreTool = "crease"');
	assert.equal(run("toolpathPoints(foldPath,'crease')[0].x"), 10);
	assert.ok(run("toolpathPoints(downPath,'cut')[0].x") > 10);
});
test('assembly fold direction defaults down and honors semantic overrides', () => {
	const run = runtime();
	assert.equal(run('assemblyFoldSign("sheet:deck", "perimeter-deck-fold")'), -1);
	run('state.foldDirections["sheet:deck:perimeter-deck-fold"] = "up"');
	assert.equal(run('assemblyFoldSign("sheet:deck", "perimeter-deck-fold")'), 1);
});
test('assembled flanges retain their parent wall hinge coordinates', () => {
	const run = runtime();
	const vertices = JSON.parse(
		run('JSON.stringify(assembledFlangeVertices(point(10,20),point(10,60),point(12,0),5,30))')
	);
	assert.deepEqual(vertices.slice(0, 2), [
		{ x: 10, y: 20, z: 30 },
		{ x: 10, y: 60, z: 30 }
	]);
	assert.deepEqual(vertices.slice(2), [
		{ x: 22, y: 55, z: 30 },
		{ x: 22, y: 25, z: 30 }
	]);
});
test('simulator respects modal coordinates, feed and explicit dwell', () => {
	const run = runtime();
	assert.equal(run('simulationMoves("G1 X10 F600\\nG1 Y10\\nG4 P2").at(-1).end'), 4);
	assert.equal(run('simulationMoves("G1 Z-3 F60")[0].end'), 6);
});
test('router preview includes spindle dwell and compensated outer perimeter', () => {
	const run = runtime();
	run('state.fabricationMode = "router"');
	assert.equal(run('validate().length'), 0);
	assert.equal(run('simulationMoves(gcode()).filter(m => m.type === "dwell")[0].end'), 2);
	assert.equal(run('simulationMoves(gcode()).some(m => m.b.x < state.deckX && m.b.x > 0)'), true);
});
test('invalid feeds and corner step are blocked before CAM generation', () => {
	const run = runtime();
	for (const field of ['cutFeed', 'scoreFeed', 'plungeFeed', 'cornerStep', 'material', 'safeZ']) {
		run(`state = defaults(); state.${field} = 0`);
		assert.ok(run('validate().length') > 0, field);
	}
});
test('new settings default for legacy designs and label offsets survive JSON roundtrip', () => {
	const run = runtime();
	assert.equal(run('normalizeState({pockets:[]}).boardFinish'), 'kraft');
	assert.equal(run('normalizeState({pockets:[]}).minimumWeb'), 6);
	run('state.pockets = [{id:"p",name:"Tablet",labelOffset:{x:12,y:-7}}]');
	assert.equal(
		run(
			'JSON.stringify(normalizeState(JSON.parse(serializedDesign()).design).pockets[0].labelOffset)'
		),
		'{"x":12,"y":-7}'
	);
});

test('legacy risers migrate to floor mounts without changing their height offset', () => {
	const run = runtime();
	run(
		`var legacy = normalizeState({pockets:[],risers:[{id:'old',name:'Old riser',w:100,d:80,h:30,assemblyZ:12,flatX:100,flatY:100,netVersion:2}]});`
	);
	assert.equal(run('legacy.risers[0].kind'), 'riser');
	assert.equal(run('legacy.risers[0].mount.target'), 'box-floor');
	assert.equal(run('legacy.risers[0].mount.offset'), 12);
});

test('recessed tray creates a linked deck opening and tapered tray net', () => {
	const run = runtime();
	run(`state.sheets.push({id:'parts',name:'Parts 1'});
    var tray = {id:'tray',kind:'tray',name:'Tablet tray',w:120,d:80,h:25,overlap:6,taper:8,flange:12,openSide:'none',sheetId:'parts',flatX:100,flatY:100,assemblyX:40,assemblyY:50,assemblyZ:0,mount:{target:'deck',face:'underside',offset:0},netVersion:3};
    state.risers=[tray];
    var deckGeometry=allGeometry();
    var assembled=trayAssemblyProfile(tray);
    state.activeSheetId='parts';
    var trayGeometry=allGeometry();`);
	assert.equal(run("deckGeometry.paths.filter(p => p.role === 'tray-opening').length"), 1);
	assert.equal(run("trayGeometry.paths.filter(p => p.role === 'tray-wall-fold').length"), 4);
	assert.equal(run("trayGeometry.paths.filter(p => p.role === 'tray-flange-fold').length"), 4);
	assert.equal(
		run(
			"trayGeometry.paths.filter(p => p.role === 'tray-wall-fold').every(p => p.foldDirection === 'up')"
		),
		true
	);
	assert.equal(run('validate().length'), 0);
	assert.equal(run('assembled.mouth.left'), -6);
	assert.equal(run('assembled.mouth.right'), 126);
	assert.equal(run('assembled.bottom.left'), 2);
	assert.equal(run('assembled.bottomZ'), run('assembled.topZ - tray.h'));
});

test('tray finger pull links the deck opening, wall recess and split flange', () => {
	const run = runtime();
	run(`state.sheets.push({id:'parts',name:'Parts 1'});
    var tray = {id:'tray',kind:'tray',name:'Tablet tray',w:120,d:80,h:25,overlap:6,taper:8,flange:12,openSide:'none',pullDiameter:38.1,pullDepth:15,pulls:{top:false,right:false,bottom:true,left:false},sheetId:'parts',flatX:100,flatY:100,assemblyX:40,assemblyY:50,assemblyZ:0,mount:{target:'deck',face:'underside',offset:0},netVersion:3};
    state.risers=[tray];
    var opening=trayOpeningPath(tray);
    var flat=annotateFoldPaths(trayPaths(tray));`);
	assert.ok(run('trayPullWidthAtMouth(tray)') > 0);
	assert.ok(run('opening.points.length') > 4);
	assert.ok(
		run('Math.min(...opening.points.map(point => point.y))') < run('state.deckY + tray.assemblyY')
	);
	assert.equal(run("flat.filter(path => path.role === 'tray-finger-pull-bottom').length"), 1);
	assert.equal(run("flat.filter(path => path.role === 'tray-flange-fold').length"), 5);
	assert.equal(run('validate().length'), 0);
});

test('platform glue flanges remain down folds in the cut program', () => {
	const run = runtime();
	run(`var platform={id:'step',kind:'platform',name:'Step',w:100,d:80,h:25,top:'panel',bottomFlange:true,cornerClosure:'glue',flange:12,seam:15,sheetId:'deck',flatX:400,flatY:400,assemblyX:20,assemblyY:20,assemblyZ:0,mount:{target:'deck',face:'top',offset:0},netVersion:2};
    state.risers=[platform];
    state.foldDirections['riser:step:riser-bottom-flange-fold']='up';
    var folds=annotateFoldPaths(riserPaths(platform)).filter(path => path.role === 'riser-bottom-flange-fold');`);
	assert.equal(run('folds.length'), 4);
	assert.equal(run("folds.every(path => path.foldDirection === 'down')"), true);
	assert.equal(run("folds.every(path => pathOperation(path) === 'cut')"), true);
	assert.equal(run("assemblyFoldDirection('riser:step','riser-bottom-flange-fold')"), 'down');
	assert.equal(
		run('JSON.stringify(supportFlangeDescriptors(platform).map(item => item.extension))'),
		'[{"x":0,"y":12},{"x":0,"y":-12},{"x":12,"y":0},{"x":-12,"y":0}]'
	);
	assert.equal(
		run(`supportFlangeDescriptors(platform).every(item => {
      var midpoint=point((item.a.x+item.b.x)/2+item.extension.x,(item.a.y+item.b.y)/2+item.extension.y);
      return midpoint.x >= 0 && midpoint.x <= platform.w && midpoint.y >= 0 && midpoint.y <= platform.d;
    })`),
		true
	);
});

test('ordinary riser floor flanges retain their outward assembly convention', () => {
	const run = runtime();
	run(
		`var riser={id:'riser',kind:'riser',w:100,d:80,h:25,flange:12}; state.risers=[riser]; var flanges=supportFlangeDescriptors(riser);`
	);
	assert.equal(
		run('JSON.stringify(flanges.map(item => item.extension))'),
		'[{"x":0,"y":-12},{"x":0,"y":12},{"x":-12,"y":0},{"x":12,"y":0}]'
	);
});

test('edge joist profiles derive one through four full folds on two opposing edges', () => {
	const run = runtime();
	run(
		`state.perimeterType='joist'; state.joistAxis='vertical'; state.deckX=76.2; state.deckY=76.2; state.joistHeight=12.7; state.joistDepth=6.35;`
	);
	for (let folds = 1; folds <= 4; folds++) {
		run(`state.joistFolds=${folds}; var geometry=allGeometry();`);
		assert.equal(
			run("geometry.paths.filter(path => path.role?.startsWith('joist-fold-')).length"),
			folds * 2
		);
		assert.equal(run("geometry.paths.filter(path => path.role === 'joist-lock-slot').length"), 0);
		assert.equal(
			run(
				"geometry.paths.filter(path => path.role?.startsWith('joist-fold-')).every(path => path.foldDirection === 'down' && pathOperation(path) === 'cut')"
			),
			true
		);
		assert.equal(run('validate().length'), 0);
	}
});

test('five-fold joists add centered locking returns and derived internal slots', () => {
	const run = runtime();
	run(
		`state.perimeterType='joist'; state.joistAxis='horizontal'; state.joistFolds=5; state.joistHeight=12.7; state.joistDepth=6.35; state.joistLockWidth=25.4; state.joistSlotClearance=0.4; var geometry=allGeometry(); var ordered=plannedToolpaths(geometry.paths).paths;`
	);
	assert.equal(
		run("geometry.paths.filter(path => path.role?.startsWith('joist-fold-')).length"),
		10
	);
	assert.equal(run("geometry.paths.filter(path => path.role === 'joist-lock-slot').length"), 2);
	assert.equal(run("geometry.paths.filter(path => path.role === 'joist-lock-tab').length"), 4);
	assert.equal(
		run(
			"Math.max(...ordered.filter(entry => entry.path.role === 'joist-lock-slot').map(entry => machiningStage(entry.path))) < Math.min(...ordered.filter(entry => entry.path.role === 'joist-lock-tab').map(entry => machiningStage(entry.path)))"
		),
		true
	);
	assert.equal(run('raisedDeckHeight()'), 12.7);
	assert.equal(run('validate().length'), 0);
});

test('joist flat extents follow the selected edge pair', () => {
	const run = runtime();
	run(
		`state.perimeterType='joist'; state.joistFolds=4; state.joistHeight=10; state.joistDepth=5; state.joistAxis='vertical'; var vertical=perimeterExtents(); state.joistAxis='horizontal'; var horizontal=perimeterExtents();`
	);
	assert.equal(run('JSON.stringify(vertical)'), '{"left":30,"right":30,"bottom":0,"top":0}');
	assert.equal(run('JSON.stringify(horizontal)'), '{"left":0,"right":0,"bottom":30,"top":30}');
});

test('joist 3D parts form closed beams beneath the selected deck edges', () => {
	const run = runtime();
	run(
		`state.perimeterType='joist'; state.joistAxis='vertical'; state.joistFolds=4; state.joistHeight=12.7; state.joistDepth=6.35; var parts=joistAssemblyParts(3);`
	);
	assert.equal(run('parts.length'), 8);
	assert.equal(
		run(
			"parts.filter(part => part.kind === 'closing-panel').every(part => part.z === state.joistHeight - 3 && part.w === state.joistDepth)"
		),
		true
	);
	assert.equal(
		run('JSON.stringify([...new Set(parts.map(part => part.side))].sort())'),
		'["left","right"]'
	);
	run('state.joistFolds=5; parts=joistAssemblyParts(3)');
	assert.equal(run('parts.length'), 10);
	assert.equal(
		run(
			"parts.filter(part => part.kind === 'locking-return').every(part => part.d === state.joistLockWidth && part.h === state.joistHeight)"
		),
		true
	);
});

test('platform steps resolve their height from another support', () => {
	const run = runtime();
	run(`var base={id:'base',kind:'riser',w:100,d:80,h:30,assemblyX:20,assemblyY:30,assemblyZ:0,mount:{target:'box-floor',face:'top',offset:10}};
    var step={id:'step',kind:'platform',w:40,d:30,h:15,assemblyX:5,assemblyY:7,assemblyZ:0,mount:{target:'base',face:'top',offset:5}};
    state.risers=[base,step];`);
	assert.equal(run('supportMountPlane(base)'), 10);
	assert.equal(run('supportTopZ(base)'), 40);
	assert.equal(run('supportMountPlane(step)'), 45);
	assert.equal(run('supportTopZ(step)'), 60);
	assert.equal(run('JSON.stringify(supportAssemblyOrigin(step))'), '{"x":25,"y":37}');
});

test('label placement changes SVG annotations without changing machine motion', () => {
	const run = runtime();
	run(`state.pockets = [{id:'p',name:'Tablet', x:150,y:150,w:100,h:100,
    shape:'rectangle',sides:{top:false,right:false,bottom:false,left:false},
    flangeEnabled:false,relief:3,wallDepth:20,pulls:{},pullDiameter:20}];
    var originalProgram = gcode(); state.pockets[0].labelOffset = {x:12,y:-7};`);
	assert.equal(run('gcode() === originalProgram'), true);
	assert.equal(run('designSvg().includes(\'x="167" y="361.6"\')'), true);
});

test('routing shortens travel, safely reverses open paths and preserves source geometry', () => {
	const run = runtime();
	run(`var paths = [line(point(200,0),point(210,0),'cut'), line(point(10,0),point(20,0),'cut'), line(point(100,0),point(110,0),'cut')];
    var plan = plannedToolpaths(paths);`);
	assert.ok(run('plan.travel < plan.baselineTravel'));
	assert.equal(run('plan.paths.length'), 3);
	assert.equal(run('new Set(plan.paths.flatMap(e => e.sourcePaths)).size'), 3);
	assert.equal(
		run(
			'plan.paths.every(e => JSON.stringify(e.pts) === JSON.stringify(compensatedPoints(e.path).map(p => point(round(p.x),round(p.y)))))'
		),
		true
	);
	assert.equal(run('JSON.stringify(paths[0].points)'), '[{"x":200,"y":0},{"x":210,"y":0}]');
	assert.equal(run('plan.paths[0].path.points[0].x'), 10);
});

test('connected contour fragments merge and holding bridges remain local', () => {
	const run = runtime();
	run(`var paths = [
      line(point(0,0),point(10,0),'cut',{role:'exterior'}),
      line(point(12,0),point(20,0),'cut',{role:'exterior'}),
      line(point(20,0),point(20,10),'cut',{role:'exterior'})
    ];
    var plan = plannedToolpaths(paths);`);
	assert.equal(run('plan.paths.length'), 2);
	assert.equal(run('plan.baselineLifts - plan.lifts'), 1);
	assert.equal(run('new Set(plan.paths.flatMap(e => e.sourcePaths)).size'), 3);
	assert.equal(
		run(
			'Math.hypot(plan.paths[1].pts[0].x-plan.paths[0].pts.at(-1).x,plan.paths[1].pts[0].y-plan.paths[0].pts.at(-1).y)'
		),
		2
	);
});

test('adjacent score edges continue around a shared corner', () => {
	const run = runtime();
	run(`var paths = [
      line(point(100,0),point(100,100),'score',{role:'perimeter-deck-fold',foldDirection:'down'}),
      line(point(0,0),point(100,0),'score',{role:'perimeter-deck-fold',foldDirection:'down'})
    ];
    var plan = plannedToolpaths(paths);`);
	assert.equal(run('plan.paths.length'), 1);
	assert.equal(run('plan.paths[0].sourcePaths.length'), 2);
	assert.equal(run('plan.paths[0].path.points.length'), 3);
});

test('closed contours may choose a nearer start without changing winding', () => {
	const run = runtime();
	run(`state.fabricationMode = 'router';
    var closed = {type:'cut',closed:true,role:'pocket-opening',points:[point(100,100),point(10,100),point(10,10),point(100,10)]};
    var before = closed.points.reduce((a,p,i,all) => a + p.x*all[(i+1)%all.length].y - all[(i+1)%all.length].x*p.y, 0);
    var entry = plannedToolpaths([closed]).paths[0];
    var after = entry.path.points.reduce((a,p,i,all) => a + p.x*all[(i+1)%all.length].y - all[(i+1)%all.length].x*p.y, 0);`);
	assert.equal(run('entry.path.points[0].x'), 10);
	assert.equal(run('entry.path.points[0].y'), 10);
	assert.equal(run('Math.sign(after)'), run('Math.sign(before)'));
});

test('constrained relocation improves a nearest-neighbor local trap', () => {
	const run = runtime();
	run(`var entries = ${JSON.stringify([
		{ id: 0, s: { x: 47, y: 26 }, e: { x: 2, y: 14 } },
		{ id: 1, s: { x: 65, y: 7 }, e: { x: 39, y: 12 } },
		{ id: 2, s: { x: 26, y: 35 }, e: { x: 99, y: 10 } },
		{ id: 3, s: { x: 45, y: 87 }, e: { x: 96, y: 54 } },
		{ id: 4, s: { x: 1, y: 79 }, e: { x: 78, y: 48 } },
		{ id: 5, s: { x: 21, y: 16 }, e: { x: 38, y: 71 } },
		{ id: 6, s: { x: 32, y: 49 }, e: { x: 86, y: 51 } }
	])}.map(item => ({path:{id:item.id},pts:[item.s,item.e]}));
    var greedy = greedyStageOrder([entries]);
    var improved = improveConstrainedRoute(greedy,[entries.length]);`);
	assert.ok(run('rapidTravel(improved) < rapidTravel(greedy) - 50'));
	assert.equal(run('JSON.stringify(improved.map(e => e.path.id))'), '[5,4,6,3,2,1,0]');
});

test('score, internal slots, riser outlines and exterior follow dependency stages', () => {
	const run = runtime();
	run(`state.risers = [{id:'r', flatX:50, flatY:100, w:100,d:80,h:30,seam:12,flange:10,bottomFlange:true,cornerClosure:'lock'}];
    var paths = [...riserPaths(state.risers[0]), ...exteriorPaths().paths];
    var ordered = plannedToolpaths(paths).paths;`);
	assert.equal(
		run(
			'ordered.every((entry,i) => !i || machiningStage(ordered[i-1].path) <= machiningStage(entry.path))'
		),
		true
	);
	assert.equal(run('ordered.filter(e => e.path.role === "riser-lock-slot").length'), 4);
	assert.equal(run('new Set(ordered.flatMap(e => e.sourcePaths)).size === paths.length'), true);
	assert.equal(run('ordered.length < paths.length'), true);
	assert.equal(run('ordered.at(-1).path.role'), 'exterior');
});

test('routing never increases total XY travel and design order remains selectable', () => {
	const run = runtime();
	assert.equal(run('plannedToolpaths().travel <= plannedToolpaths().baselineTravel'), true);
	run('state.toolpathOrder = "design"');
	assert.equal(run('plannedToolpaths().travel === plannedToolpaths().baselineTravel'), true);
	assert.equal(run('plannedToolpaths([]).travel'), 0);
});

test('simulation XY rapid distance agrees with routing report', () => {
	const run = runtime();
	const distance = run(
		`simulationMoves(gcode()).filter(m => m.type === 'travel').reduce((sum,m) => sum+Math.hypot(m.b.x-m.a.x,m.b.y-m.a.y),0)`
	);
	assert.ok(Math.abs(distance - run('plannedToolpaths().travel')) < 1e-8);
});
