import buildInfo from "../../build-info.json";

export function BuildVersion() {
  return (
    <div
      className="version"
      title={`应用版本 ${buildInfo.displayVersion}\n构建于 ${buildInfo.builtAtLabel}`}
    >
      <span>应用版本</span>
      <code>{buildInfo.displayVersion}</code>
      <span>{buildInfo.builtAtLabel}</span>
    </div>
  );
}
