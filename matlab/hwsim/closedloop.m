function R = closedloop(opt)
% Closed-loop sim of the DEPLOYED PerceptionAndGuidance logic (chart code pulled from the .slx):
% latestPacket -> ned2body -> lineGuidance (enabled only while 'enable') -> body2ned -> setpoint,
% with a simple PX4-like position follower and a synthetic downward camera (red line + landing circle).
% opt fields: track [N E] waypoints (world), yaw0 spawn yaw (rad), Ktrue m/px at 0.8 m, armT s, T s, lineW m, circD m
if nargin < 1, opt = struct; end
d = struct('track', [0.5 1.0; 2.5 1.0; 2.45 3.0], 'yaw0', 0, 'Ktrue', 0.0051, 'armT', 5, 'T', 120, ...
           'lineW', 0.1, 'circD', 0.2, 'vmax', 0.6, 'plot', '', 'pktDrop', 0, 'yawNoise', 0, 'flip', '');
f = fieldnames(d); for i = 1:numel(f), if ~isfield(opt, f{i}), opt.(f{i}) = d.(f{i}); end, end
clear m_lineGuidance m_body2ned m_ned2body m_latestPacket
wp = opt.track; spawn = wp(1, :);
dt = 0.02; N = round(opt.T / dt);
p = [spawn 0]; v = [0 0 0]; yaw = opt.yaw0;      % truth (world NED)
traj = zeros(4, 1, 'single'); ned = zeros(4, 1); sp = [0 0 0 0];
log = zeros(N, 9); [cc, rr] = meshgrid(1:160, 1:120); fpx = 60.5 - rr; rpx = cc - 80.5;
camPose = [p yaw]; landed = false; dbgL = zeros(N, 1); dbgC = zeros(N, 1);
for k = 1:N
    t = (k - 1) * dt; armed = t >= opt.armT;
    % Pixhawk -> Pi packet at 10 Hz, only while armed (as in the 19:28 flight), local frame = relative to spawn
    pkt = single([]); valid = false;
    if armed && mod(k - 1, 5) == 0 && rand >= opt.pktDrop
        pkt = single([p(1) - spawn(1), p(2) - spawn(2), p(3), wrapToPi(yaw + opt.yawNoise * randn), 221]); valid = true;
    end
    if valid, [pos, en] = m_latestPacket(pkt, true); else, [pos, en] = m_latestPacket(single(zeros(1, 5)), false); end
    if mod(k - 1, 10) == 0                         % 0.2 s: camera + guidance + localToNED
        if en
            mask = render(camPose, wp, opt, fpx, rpx);
            switch opt.flip, case 'lr', mask = fliplr(mask); case 'ud', mask = flipud(mask); case 'rot', mask = rot90(mask, 2); end
            cur = m_ned2body(pos, pos(4), en);
            [tj, dbg] = m_lineGuidance(mask, double(cur(:))');
            traj = single(tj); dbgL(k) = dbg(1); dbgC(k) = dbg(3);
        end
        ned = m_body2ned(double(traj), double(pos(4)), en);
        camPose = [p yaw];                          % next frame sees this pose (one-frame latency)
    end
    if mod(k - 1, 5) == 0, sp = ned(:)'; end        % Serial Write 10 Hz
    % PX4-ish follower (setpoints are in the spawn-relative local frame)
    if armed && ~landed
        tgt = [sp(1:2) + spawn, sp(3)];
        vc = 1.2 * (tgt - p); h = norm(vc(1:2)); if h > opt.vmax, vc(1:2) = vc(1:2) * opt.vmax / h; end
        vc(3) = max(min(vc(3), 0.5), -0.7);
        v = v + (vc - v) * min(1, dt / 0.35); p = p + v * dt;
        dy = wrapToPi(sp(4) - yaw); yaw = wrapToPi(yaw + max(min(2 * dy, 1.5), -1.5) * dt);
        if p(3) > 0, p(3) = 0; v(3) = 0; if t > opt.armT + 3, landed = true; end, end
    end
    log(k, :) = [t p yaw sp(1:2) + spawn en dbgL(k)];
end
% score: distance of the flown track (above 0.5 m) to the line, landing error to circle centre
L = log(:, 2:3); air = log(:, 4) < -0.5; dl = arrayfun(@(i) segDist(L(i, :), wp), find(air));
R.maxErr = max([dl; 0]); R.meanErr = mean([dl; 0]); u = wp(end, :) - wp(end - 1, :); cz = wp(end, :) + u / norm(u) * 0.3; R.land = norm(p(1:2) - cz); R.landed = landed;
R.landT = log(find(log(:, 4) > -0.05 & log(:, 1) > opt.armT + 3, 1), 1); if isempty(R.landT), R.landT = NaN; end
R.states = unique(dbgL(dbgL ~= 0))'; R.log = [log dbgC];
if ~isempty(opt.plot)
    fg = figure('Visible', 'off'); hold on; axis equal; grid on;
    plot(wp(:, 2), wp(:, 1), 'r-', 'LineWidth', 4); th = linspace(0, 2*pi, 50);
    u = wp(end, :) - wp(end - 1, :); cz = wp(end, :) + u / norm(u) * 0.3; plot(cz(2) + opt.circD/2*cos(th), cz(1) + opt.circD/2*sin(th), 'r');
    plot(L(:, 2), L(:, 1), 'b-'); plot(p(2), p(1), 'kx', 'MarkerSize', 12, 'LineWidth', 2);
    xlabel('East m'); ylabel('North m');
    title(sprintf('%s  maxErr %.2f  land %.2f m', strrep(opt.plot, '_', ' '), R.maxErr, R.land));
    exportgraphics(fg, fullfile(fileparts(mfilename('fullpath')), [opt.plot '.png'])); close(fg);
end
end

function m = render(pose, wp, opt, fpx, rpx)
h = max(-pose(3), 0.05); mpp = opt.Ktrue * h / 0.8; c = cos(pose(4)); s = sin(pose(4));
Nw = pose(1) + mpp * (fpx * c - rpx * s); Ew = pose(2) + mpp * (fpx * s + rpx * c);
m = false(size(Nw));
for i = 1:size(wp, 1) - 1
    a = wp(i, :); b = wp(i + 1, :); ab = b - a; L2 = ab * ab';
    u = min(max(((Nw - a(1)) * ab(1) + (Ew - a(2)) * ab(2)) / L2, 0), 1);
    m = m | hypot(Nw - a(1) - u * ab(1), Ew - a(2) - u * ab(2)) < opt.lineW / 2;
end
u = wp(end, :) - wp(end - 1, :); cz = wp(end, :) + u / norm(u) * 0.3;
m = m | hypot(Nw - cz(1), Ew - cz(2)) < opt.circD / 2;
end

function d = segDist(q, wp)
d = inf;
for i = 1:size(wp, 1) - 1
    a = wp(i, :); ab = wp(i + 1, :) - a; u = min(max((q - a) * ab' / (ab * ab'), 0), 1);
    d = min(d, norm(q - a - u * ab));
end
end
