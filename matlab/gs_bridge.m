function gs_bridge(action, port)
%GS_BRIDGE Let the Ground Station "Mission" page drive this MATLAB session.
%   gs_bridge          start (polls the Ground Station on 127.0.0.1:47801 once a second)
%   gs_bridge stop     stop
%   gs_bridge('start', 47802)   if the Ground Station runs on another port
%
%   Commands come only from the Ground Station on this laptop. Each runs here, in this MATLAB,
%   while MATLAB is idle; its output also appears on the Mission page.
%     check         open project, InitVars, load model, print every flight setting, compile
%     deploy        build and copy the model to the Pi, do NOT start it (start from the Mission page)
%     deploy_start  build, copy and start (same as Build, Deploy & Start)
%     enable_tx / disable_tx   add / remove the telemetry sender (groundStationTx)
%     set_ip <ip>   point the model at the Pi (set_drone_ip)
%     sim           closed-loop test of the guidance code in the model, on four tracks

if nargin < 1 || isempty(action), action = 'start'; end
if nargin < 2 || isempty(port), port = 47801; end
old = timerfind('Name', 'gs_bridge');
if ~isempty(old), stop(old); delete(old); end
if strcmpi(action, 'stop')
    fprintf('gs_bridge stopped.\n');
    return
end
here = fileparts(mfilename('fullpath'));
addpath(here);
url = sprintf('http://127.0.0.1:%d/api/matlab/', port);
t = timer('Name', 'gs_bridge', 'Period', 1, 'ExecutionMode', 'fixedSpacing', 'BusyMode', 'drop', ...
    'TimerFcn', @(~, ~) tick(url, here), 'ErrorFcn', @(~, ~) []);
start(t);
fprintf('gs_bridge running: the Ground Station Mission page now controls this MATLAB. Stop: gs_bridge stop\n');
end

% ------------------------------------------------------------------------------------------
function tick(url, here)
persistent info lastErr
if isempty(info), info = struct('state', 'idle'); end
opts = weboptions('MediaType', 'application/json', 'ContentType', 'json', 'Timeout', 3, ...
    'HeaderFields', {'X-Ground-Station', '1'});
try
    job = webwrite([url 'poll'], struct('info', info), opts);
    lastErr = '';
catch e
    if ~strcmp(lastErr, e.message)
        fprintf('gs_bridge: Ground Station not reachable (%s). Still trying.\n', e.message);
        lastErr = e.message;
    end
    return
end
if ~isstruct(job) || ~isfield(job, 'cmd') || isempty(job.cmd)
    return
end
dfile = [tempname '.txt'];
try, webwrite([url 'started'], struct('id', job.id, 'diary', dfile), opts); catch, end
diary(dfile); diary on;
ok = true; err = '';
fprintf('\n===== Ground Station: %s %s =====\n', job.cmd, job.arg);
try
    runCommand(job.cmd, job.arg, here);
catch e
    ok = false; err = e.message;
    fprintf(2, 'ERROR: %s\n', getReport(e, 'basic'));
end
try, info = modelInfo(); catch, end
diary off;
pause(0.3);
try
    webwrite([url 'result'], struct('id', job.id, 'ok', ok, 'error', err, 'info', info), opts);
catch
end
try, delete(dfile); catch, end
end

% ------------------------------------------------------------------------------------------
function runCommand(cmd, arg, here)
mdl = 'PerceptionAndGuidance';
switch cmd
    case 'check'
        prep(mdl);
        printSettings(mdl);
        fprintf('Compiling the model (update diagram)...\n');
        set_param(mdl, 'SimulationCommand', 'update');
        fprintf('Compile OK.\n');
        pingPi(mdl);
    case {'deploy', 'deploy_start'}
        prep(mdl);
        printSettings(mdl);
        cs = getActiveConfigSet(mdl);
        d = get_param(cs, 'CoderTargetData'); was = d.Runtime.BuildAction;
        want = 'Build';
        if strcmp(cmd, 'deploy_start'), want = 'Build and run'; end
        codertarget.data.setParameterValue(cs, 'Runtime.BuildAction', want);
        restore = onCleanup(@() restoreAction(mdl, was));
        if ~strcmp(get_param(mdl, 'ExtMode'), 'off'), error('External mode is on: fly with Build, not Monitor & Tune.'); end
        fprintf('Building (%s) for %s ... this takes a few minutes.\n', want, boardAddr(mdl));
        slbuild(mdl);
        if strcmp(cmd, 'deploy')
            fprintf('DEPLOYED (not started). Start it from the Mission page: Start model.\n');
        else
            fprintf('DEPLOYED AND STARTED.\n');
        end
        clear restore
    case 'enable_tx'
        prep(mdl);
        enable_groundstation;
    case 'disable_tx'
        prep(mdl);
        disable_groundstation;
    case 'set_ip'
        prep(mdl);
        set_drone_ip(arg);
    case 'sim'
        prep(mdl);
        runSim(mdl, here);
    otherwise
        error('Unknown command %s', cmd);
end
end

function restoreAction(mdl, was)
try
    codertarget.data.setParameterValue(getActiveConfigSet(mdl), 'Runtime.BuildAction', was);
    set_param(mdl, 'Dirty', 'off');
catch
end
end

function prep(mdl)
root = '';
try, root = char(currentProject().RootFolder); catch, end
if isempty(root) || ~isfolder(fullfile(root, 'perception'))
    def = fullfile(getenv('USERPROFILE'), 'MATLAB', 'Projects', 'examples', 'PX4MultiCopterPerceptionAndControl');
    fprintf('Opening project %s\n', def);
    openProject(def);
    root = char(currentProject().RootFolder);
end
evalin('base', 'InitVars');
if ~bdIsLoaded(mdl)
    load_system(fullfile(root, 'perception', [mdl '.slx']));
end
w = fullfile(root, 'work');
if isfolder(w), cd(w); end
end

function a = boardAddr(mdl)
a = '?';
try
    b = codertarget.data.getParameterValue(getActiveConfigSet(mdl), 'BoardParameters');
    a = sprintf('%s@%s', b.Username, b.DeviceAddress);
catch
end
end

function printSettings(mdl)
i = modelInfo();
fprintf('Pi target        : %s\n', i.pi);
fprintf('Simulation flag  : %d   (must be 0)\n', i.simulation);
fprintf('Stop time        : %s   (must be Inf)\n', i.tfinal);
fprintf('External mode    : %s   (must be off)\n', i.extmode);
fprintf('Guidance         : %s\n', i.guidance);
fprintf('Camera           : %s\n', i.camera);
fprintf('Telemetry sender : %s\n', i.tx);
fprintf('Unsaved changes  : %s\n', i.dirty);
bad = {};
if i.simulation ~= 0, bad{end+1} = 'Simulation flag'; end
if ~strcmp(i.tfinal, 'Inf'), bad{end+1} = 'stop time'; end
if ~strcmp(i.extmode, 'off'), bad{end+1} = 'external mode'; end
if ~contains(i.guidance, 'x70'), bad{end+1} = 'guidance is not x70'; end
if isempty(bad), fprintf('ALL FLIGHT SETTINGS OK\n'); else, fprintf(2, 'CHECK: %s\n', strjoin(bad, ', ')); end
end

function i = modelInfo()
mdl = 'PerceptionAndGuidance';
i = struct('state', 'idle', 'loaded', bdIsLoaded(mdl), 'pi', '', 'simulation', -1, 'tfinal', '', ...
    'extmode', '', 'guidance', '', 'camera', '', 'tx', '', 'dirty', '');
try, i.simulation = double(evalin('base', 'Simulation')); catch, end
try, i.tfinal = num2str(evalin('base', 'TFinal')); catch, end
if ~i.loaded, return; end
i.pi = boardAddr(mdl);
i.extmode = get_param(mdl, 'ExtMode');
i.dirty = get_param(mdl, 'Dirty');
ch = find(sfroot, '-isa', 'Stateflow.EMChart', 'Path', [mdl '/Image processing and Guidance/lineGuidance']);
if ~isempty(ch)
    tok = regexp(ch.Script, '% (x\d+)[ (:]', 'tokens');
    v = 'unknown';
    if ~isempty(tok), v = max(cellfun(@(c) str2double(c{1}(2:end)), tok)); v = sprintf('x%d', v); end
    hw = 'HARDWARE = true';
    if ~contains(ch.Script, 'HARDWARE = true;'), hw = 'HARDWARE = FALSE (sim scene!)'; end
    i.guidance = sprintf('%s, %s', v, hw);
end
cam = [mdl '/Image processing and Guidance/get camera data/Rpi Camera Processing/Raspberry Pi Camera Video Capture'];
if getSimulinkBlockHandle(cam) > 0
    i.camera = sprintf('%s every %s s, hflip %s, vflip %s', get_param(cam, 'Resolution'), ...
        get_param(cam, 'SampleTime'), get_param(cam, 'HorizontalFlip'), get_param(cam, 'VerticalFlip'));
end
if getSimulinkBlockHandle([mdl '/Image processing and Guidance/groundStationTx']) > 0
    i.tx = 'ON (UDP 47800)';
else
    i.tx = 'off';
end
end

function pingPi(mdl)
b = codertarget.data.getParameterValue(getActiveConfigSet(mdl), 'BoardParameters');
[s, out] = system(['ping -n 1 -w 1500 ' b.DeviceAddress]);
if s == 0 && contains(out, 'TTL='), fprintf('Pi %s answers ping.\n', b.DeviceAddress);
else, fprintf(2, 'Pi %s does NOT answer ping (power / network).\n', b.DeviceAddress); end
end

% ------------------------------------------------------------------------------------------
function runSim(mdl, here)
% Pull the chart code out of the model (exactly what flies) and fly it in hwsim/closedloop.m.
sd = fullfile(tempdir, 'gs_hwsim'); if ~isfolder(sd), mkdir(sd); end
map = {'/Image processing and Guidance/lineGuidance', 'm_lineGuidance'; ...
       '/localToNED/MATLAB Function', 'm_body2ned'; ...
       '/getCurrentPosition/Rpi Get Current Position/MATLAB Function2', 'm_ned2body'; ...
       '/getCurrentPosition/Rpi Get Current Position/latestPacket', 'm_latestPacket'};
for k = 1:size(map, 1)
    ch = find(sfroot, '-isa', 'Stateflow.EMChart', 'Path', [mdl map{k, 1}]);
    if isempty(ch), error('Block not found: %s', map{k, 1}); end
    s = regexprep(ch.Script, '(function\s+[^=]*=\s*)\w+(\s*\()', ['$1' map{k, 2} '$2'], 'once');
    fid = fopen(fullfile(sd, [map{k, 2} '.m']), 'w'); fwrite(fid, s); fclose(fid);
end
copyfile(fullfile(here, 'hwsim', 'closedloop.m'), sd, 'f');
old = cd(sd); back = onCleanup(@() cd(old)); rehash;
T = {'L track', [0.5 1.0; 2.5 1.0; 2.45 3.0]; ...
     'arena roof', [0.5 0.5; 1.3 1.2; 1.8 2.0; 1.5 2.8; 1.2 3.3]; ...
     'sharp 40 deg', [0.5 0.5; 0.5 3.0; 1.79 1.47]; ...
     'zigzag', [0.4 0.4; 1.6 0.4; 1.0 1.2; 2.4 1.6; 1.4 2.4; 1.6 3.4; 3.0 3.0]};
fprintf('Closed loop: model guidance + position link + simple PX4 follower + fake camera (0.0051 m/px, 0.2 m circle).\n');
nok = 0;
for k = 1:size(T, 1)
    rng(1);
    R = closedloop(struct('track', T{k, 2}, 'T', 90));
    pass = R.landed && R.land < 0.15;
    nok = nok + pass;
    word = {'FAIL', 'PASS'};
    fprintf('%-13s %s  landed %.2f m from circle centre after %.0f s, worst path error %.2f m\n', ...
        T{k, 1}, word{pass + 1}, R.land, R.landT, R.maxErr);
end
fprintf('SIM RESULT: %d of %d tracks pass.\n', nok, size(T, 1));
end
