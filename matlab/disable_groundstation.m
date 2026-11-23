function disable_groundstation()
%DISABLE_GROUNDSTATION Restore PerceptionAndGuidance.slx from the backup enable_groundstation made.

here = fileparts(mfilename('fullpath'));
try
    root = char(currentProject().RootFolder);
catch
    root = fullfile(here, '..', '..', '..', 'minidrone_2026');
end
percDir = fullfile(root, 'perception');
mdlFile = fullfile(percDir, 'PerceptionAndGuidance.slx');
bak = fullfile(percDir, 'PerceptionAndGuidance.pre_groundstation.slx');
if ~isfile(bak)
    error('disable_groundstation:noBackup', 'No backup found at %s', bak);
end
if bdIsLoaded('PerceptionAndGuidance')
    close_system('PerceptionAndGuidance', 0);
end
copyfile(bak, mdlFile, 'f');
delete(bak);
fprintf('PerceptionAndGuidance.slx restored; ground station sender removed.\n');
end
