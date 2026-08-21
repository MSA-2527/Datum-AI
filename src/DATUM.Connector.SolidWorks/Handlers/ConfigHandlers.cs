using System;
using System.Collections.Generic;
using Datum.Contracts;
using Datum.Connector.SolidWorks.Execution;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace Datum.Connector.SolidWorks.Handlers
{
    /// <summary>
    /// Configuration operations — the backbone of variant design (problem A1: the same
    /// bracket in forty sizes). The Variant Matrix in the Parameter Inspector compiles
    /// straight into these, with no model involved.
    /// </summary>
    internal static class ConfigHandlers
    {
        public static void Register(Dictionary<string, OpHandler> h)
        {
            h["config.create"] = Create;
            h["config.derive"] = Derive;
            h["config.activate"] = Activate;
            h["config.set_dimension"] = SetDimension;
            h["config.set_suppression"] = SetSuppression;
            h["config.set_property"] = SetProperty;
            h["config.delete"] = Delete;
        }

        private static void Create(OpContext c)
        {
            string name = c.RequireString("name");
            var existing = c.Doc.GetConfigurationNames() as string[] ?? new string[0];
            foreach (var e in existing)
                if (string.Equals(e, name, StringComparison.OrdinalIgnoreCase))
                {
                    c.Output["created"] = false;   // idempotent replay
                    c.Output["name"] = name;
                    return;
                }

            var cfg = c.Doc.AddConfiguration3(
                name,
                c.GetString("comment", "") ?? "",
                c.GetString("alternateName", "") ?? "",
                (int)swConfigurationOptions2_e.swConfigOption_DontActivate) as IConfiguration;

            if (cfg == null)
                throw new OpException(KernelError.ComFailure, $"Could not create configuration '{name}'.");

            c.Output["created"] = true;
            c.Output["name"] = cfg.Name;
        }

        private static void Derive(OpContext c)
        {
            string name = c.RequireString("name");
            string parent = c.RequireString("parent");

            var cfg = c.Doc.AddConfiguration3(
                name, c.GetString("comment", "") ?? "", "",
                (int)swConfigurationOptions2_e.swConfigOption_DontActivate) as IConfiguration;

            if (cfg == null)
                throw new OpException(KernelError.ComFailure, $"Could not create '{name}'.");

            // IConfiguration exposes the parent link directly; setting it after creation
            // is the only reliable way to derive across SOLIDWORKS versions.
            var parentCfg = c.Doc.GetConfigurationByName(parent) as IConfiguration;
            if (parentCfg == null)
                throw new OpException(KernelError.PreconditionFailed, $"No configuration named '{parent}'.");

            cfg.SetParentConfiguration(parent);
            c.Output["name"] = cfg.Name;
        }

        private static void Activate(OpContext c)
        {
            string name = c.RequireString("name");
            if (!c.Doc.ShowConfiguration2(name))
                throw new OpException(KernelError.PreconditionFailed,
                    $"Configuration '{name}' could not be activated (does it exist?).");
            c.Output["active"] = name;
        }

        private static void SetDimension(OpContext c)
        {
            string dimName = c.RequireString("dimension");
            string config = c.RequireString("configuration");
            double value = c.GetLengthMetres("value");

            var dim = c.Doc.Parameter(dimName) as IDimension
                      ?? throw new OpException(KernelError.PreconditionFailed,
                             $"No dimension named '{dimName}'.");

            int rc = dim.SetSystemValue3(value,
                (int)swSetValueInConfiguration_e.swSetValue_InSpecificConfigurations,
                new string[] { config });

            if (rc != (int)swSetValueReturnStatus_e.swSetValue_Successful)
                throw new OpException(KernelError.ComFailure,
                    $"Could not set '{dimName}' in configuration '{config}' (status {rc}).");
        }

        private static void SetSuppression(OpContext c)
        {
            c.RequireTargets();
            string config = c.RequireString("configuration");
            bool suppress = c.GetBool("suppressed", true);

            int action = suppress
                ? (int)swFeatureSuppressionAction_e.swSuppressFeature
                : (int)swFeatureSuppressionAction_e.swUnSuppressFeature;

            int n = 0;
            foreach (var t in c.Targets)
                if (t is IFeature f && f.SetSuppression2(action,
                        (int)swInConfigurationOpts_e.swSpecifyConfiguration, new string[] { config }))
                    n++;

            c.Output["changed"] = n;
        }

        private static void SetProperty(OpContext c)
        {
            string config = c.RequireString("configuration");
            string name = c.RequireString("name");
            string value = c.GetString("value", "") ?? "";

            var cpm = c.Doc.Extension.CustomPropertyManager[config];
            cpm.Add3(name, (int)swCustomInfoType_e.swCustomInfoText, value,
                     (int)swCustomPropertyAddOption_e.swCustomPropertyReplaceValue);
        }

        private static void Delete(OpContext c)
        {
            string name = c.RequireString("name");
            string active = c.Doc.ConfigurationManager.ActiveConfiguration?.Name ?? "";

            if (string.Equals(active, name, StringComparison.OrdinalIgnoreCase))
                throw new OpException(KernelError.PreconditionFailed,
                    "Cannot delete the active configuration. Activate another one first.");

            if (!c.Doc.DeleteConfiguration2(name))
                throw new OpException(KernelError.ComFailure, $"Could not delete configuration '{name}'.");
        }
    }
}
