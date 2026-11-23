function enable_groundstation()
%ENABLE_GROUNDSTATION Add the ground station telemetry sender to PerceptionAndGuidance.slx.
%
%   Run once, with the minidrone_2026 project open, before deploying to the drone.
%   It adds one MATLAB Function block (groundStationTx) next to lineGuidance that reads
%   lineGuidance's inputs (mask, position) and outputs (setpoint, dbg) and broadcasts them
%   over UDP 47800. No existing flight signal is changed; only the dbgTerm terminator
%   that used to swallow lineGuidance's dbg output is replaced.
%
%   A backup is saved as perception/PerceptionAndGuidance.pre_groundstation.slx.
%   Undo with disable_groundstation.

here = fileparts(mfilename('fullpath'));
root = projectRoot(here);
percDir = fullfile(root, 'perception');
mdlFile = fullfile(percDir, 'PerceptionAndGuidance.slx');
bak = fullfile(percDir, 'PerceptionAndGuidance.pre_groundstation.slx');
mdl = 'PerceptionAndGuidance';
sys = [mdl '/Image processing and Guidance'];
lg = [sys '/lineGuidance'];
tx = [sys '/groundStationTx'];

% helper files the generated code needs, next to the model (already on the project path)
copyfile(fullfile(here, 'gs_udp.h'), percDir, 'f');
copyfile(fullfile(here, 'gs_udp_dir.m'), percDir, 'f');
try
    p = currentProject;
    addFile(p, fullfile(percDir, 'gs_udp.h'));
    addFile(p, fullfile(percDir, 'gs_udp_dir.m'));
catch
    % no project open, or files already in it
end

load_system(mdlFile);
if getSimulinkBlockHandle(tx) > 0
    updateScript(tx, here);
    save_system(mdl);
    fprintf('Ground station sender already present; block code refreshed. Nothing else changed.\n');
    return
end
if getSimulinkBlockHandle(lg) <= 0
    error('enable_groundstation:noGuidance', 'Block not found: %s', lg);
end

if ~isfile(bak)
    copyfile(mdlFile, bak);
    fprintf('Backup: %s\n', bak);
end

ph = get_param(lg, 'PortHandles');
srcMask = srcPort(ph.Inport(1));
srcPos = srcPort(ph.Inport(2));

% lineGuidance output 2 (dbg) currently ends in a Terminator; remove it
dbgLine = get_param(ph.Outport(2), 'Line');
if dbgLine > 0
    dst = get_param(dbgLine, 'DstBlockHandle');
    delete_line(dbgLine);
    for d = dst(:)'
        if d > 0 && strcmp(get_param(d, 'BlockType'), 'Terminator')
            delete_block(d);
        end
    end
end

pos = get_param(lg, 'Position');
h = pos(4) - pos(2);
add_block('simulink/User-Defined Functions/MATLAB Function', tx, ...
    'Position', [pos(1), pos(4) + 60, pos(3), pos(4) + 60 + max(h, 80)]);
updateScript(tx, here);

tp = get_param(tx, 'PortHandles');
assert(numel(tp.Inport) == 4, 'groundStationTx should have 4 inputs');
add_line(sys, srcMask, tp.Inport(1), 'autorouting', 'smart');
add_line(sys, srcPos, tp.Inport(2), 'autorouting', 'smart');
add_line(sys, ph.Outport(1), tp.Inport(3), 'autorouting', 'smart');
add_line(sys, ph.Outport(2), tp.Inport(4), 'autorouting', 'smart');

set_param(mdl, 'SimulationCommand', 'update');
save_system(mdl);
fprintf(['\nGround station sender added to %s.\n' ...
    'Next: deploy as usual (Step_2_Deploy_PerceptionModel, then Build, Deploy & Start).\n' ...
    'Desktop simulation is unaffected: the block only sends in the Raspberry Pi build.\n'], mdl);
end

function updateScript(blk, here)
ch = find(sfroot, '-isa', 'Stateflow.EMChart', 'Path', blk);
ch.Script = fileread(fullfile(here, 'groundStationTx.m'));
end

function p = srcPort(inport)
l = get_param(inport, 'Line');
if l <= 0
    error('enable_groundstation:unwired', 'lineGuidance input is not connected');
end
p = get_param(l, 'SrcPortHandle');
end

function root = projectRoot(here)
try
    root = char(currentProject().RootFolder);
    if isfolder(fullfile(root, 'perception')), return; end
catch
end
root = fullfile(here, '..', '..', '..', 'minidrone_2026');
if ~isfolder(fullfile(root, 'perception'))
    error('enable_groundstation:noProject', 'Open the minidrone_2026 project first.');
end
root = char(java.io.File(root).getCanonicalPath());
end
