"""Tests for generate_case.py — US-004 acceptance criteria."""
from __future__ import annotations

import json
import math
import struct
import tempfile
from pathlib import Path

import pytest

from generate_case import (
    DEFAULT_TEMPLATE_DIR,
    dem_to_stl_binary,
    generate_case,
    validate_input,
)

SAMPLE_INPUT = Path(__file__).resolve().parent.parent.parent / "docs" / "solver" / "sample_input.json"


@pytest.fixture
def sample_data() -> dict:
    with open(SAMPLE_INPUT) as f:
        return json.load(f)


@pytest.fixture
def case_dir(sample_data: dict) -> Path:
    """Generate a case into a temp directory and return the path."""
    with tempfile.TemporaryDirectory() as tmp:
        input_file = Path(tmp) / "input.json"
        input_file.write_text(json.dumps(sample_data))
        out = Path(tmp) / "case"
        generate_case(input_file, out)
        yield out


# ---- AC1: case-template/ contains system/* and constant/* ----

class TestCaseTemplateSkeleton:
    def test_template_dir_exists(self):
        assert DEFAULT_TEMPLATE_DIR.is_dir()

    def test_system_files_exist(self):
        system = DEFAULT_TEMPLATE_DIR / "system"
        assert (system / "fvSchemes").is_file()
        assert (system / "fvSolution").is_file()
        assert (system / "faSchemes").is_file()
        assert (system / "faSolution").is_file()
        assert (system / "faMesh" / "faMeshDefinition").is_file()

    def test_constant_files_exist(self):
        constant = DEFAULT_TEMPLATE_DIR / "constant"
        assert (constant / "g").is_file()


# ---- AC2: generate_case reads input.json and populates case dir ----

class TestCaseGeneration:
    def test_generates_all_required_files(self, case_dir: Path):
        # System files (static + generated)
        assert (case_dir / "system" / "controlDict").is_file()
        assert (case_dir / "system" / "fvSchemes").is_file()
        assert (case_dir / "system" / "fvSolution").is_file()
        assert (case_dir / "system" / "faSchemes").is_file()
        assert (case_dir / "system" / "faSolution").is_file()
        assert (case_dir / "system" / "blockMeshDict").is_file()
        assert (case_dir / "system" / "decomposeParDict").is_file()
        assert (case_dir / "system" / "faMesh" / "faMeshDefinition").is_file()

        # Constant files
        assert (case_dir / "constant" / "g").is_file()
        assert (case_dir / "constant" / "transportProperties").is_file()
        assert (case_dir / "constant" / "triSurface" / "terrain.stl").is_file()

        # Initial conditions
        assert (case_dir / "0" / "h").is_file()
        assert (case_dir / "0" / "Us").is_file()

        # Provenance
        assert (case_dir / "input.json").is_file()

    def test_input_json_copied(self, case_dir: Path, sample_data: dict):
        copied = json.loads((case_dir / "input.json").read_text())
        assert copied == sample_data


# ---- AC3: Friction, entrainment, run time, output fields mapped ----

class TestParameterMapping:
    def test_friction_mu_mapped(self, case_dir: Path, sample_data: dict):
        tp = (case_dir / "constant" / "transportProperties").read_text()
        mu = sample_data["snowProfile"]["frictionMu"]
        assert f"{mu}" in tp
        assert "mu" in tp

    def test_friction_xi_mapped(self, case_dir: Path, sample_data: dict):
        tp = (case_dir / "constant" / "transportProperties").read_text()
        xi = sample_data["snowProfile"]["frictionXi"]
        assert f"{xi}" in tp
        assert "xi" in tp

    def test_density_mapped(self, case_dir: Path, sample_data: dict):
        tp = (case_dir / "constant" / "transportProperties").read_text()
        rho = sample_data["snowProfile"]["density"]
        assert f"{rho}" in tp

    def test_entrainment_mapped(self, case_dir: Path, sample_data: dict):
        tp = (case_dir / "constant" / "transportProperties").read_text()
        ef = sample_data["snowProfile"]["entrainmentFactor"]
        assert f"{ef}" in tp

    def test_end_time_reasonable(self, case_dir: Path, sample_data: dict):
        cd = (case_dir / "system" / "controlDict").read_text()
        assert "endTime" in cd
        # Should be between 30 and 300 seconds
        for line in cd.splitlines():
            if "endTime" in line and "stopAt" not in line:
                parts = line.split()
                for p in parts:
                    try:
                        val = float(p.rstrip(";"))
                        assert 30 <= val <= 300
                    except ValueError:
                        continue

    def test_output_fields_configured(self, case_dir: Path):
        cd = (case_dir / "system" / "controlDict").read_text()
        # fieldMinMax function object should list h and Us
        assert "fieldMinMax" in cd
        assert "h" in cd
        assert "Us" in cd

    def test_delta_t_positive(self, case_dir: Path):
        cd = (case_dir / "system" / "controlDict").read_text()
        for line in cd.splitlines():
            stripped = line.strip()
            if stripped.startswith("deltaT"):
                val = float(stripped.split()[-1].rstrip(";"))
                assert val > 0

    def test_decompose_par_dict(self, case_dir: Path):
        dp = (case_dir / "system" / "decomposeParDict").read_text()
        assert "numberOfSubdomains" in dp
        assert "scotch" in dp


# ---- AC4: DEM converted to terrain format ----

class TestDEMConversion:
    def test_stl_file_non_empty(self, case_dir: Path):
        stl = case_dir / "constant" / "triSurface" / "terrain.stl"
        assert stl.stat().st_size > 84  # header + count

    def test_stl_triangle_count(self, sample_data: dict):
        """Each DEM quad produces 2 triangles."""
        dem = sample_data["dem"]
        rows, cols = dem["rows"], dem["cols"]
        expected = (rows - 1) * (cols - 1) * 2

        stl_bytes = dem_to_stl_binary(dem)
        n_triangles = struct.unpack_from("<I", stl_bytes, 80)[0]
        assert n_triangles == expected

    def test_stl_vertex_coordinates(self, sample_data: dict):
        """First triangle should start at origin with correct z."""
        dem = sample_data["dem"]
        stl_bytes = dem_to_stl_binary(dem)

        # Skip header (80) + count (4) + normal (12) → first vertex at offset 96
        x, y, z = struct.unpack_from("<3f", stl_bytes, 96)
        assert x == 0.0
        assert y == 0.0
        assert z == pytest.approx(dem["elevation"][0], abs=0.1)

    def test_stl_skips_null_cells(self):
        """Quads with null elevation produce no triangles."""
        dem = {
            "origin": [0, 0],
            "cellSize": 10,
            "rows": 2,
            "cols": 2,
            "elevation": [100, 200, None, 300],
        }
        stl_bytes = dem_to_stl_binary(dem)
        n = struct.unpack_from("<I", stl_bytes, 80)[0]
        assert n == 0  # null cell → skip quad


# ---- AC5: releaseCells → initial condition field ----

class TestReleaseCellsConversion:
    def test_h_field_has_nonuniform_values(self, case_dir: Path):
        h_text = (case_dir / "0" / "h").read_text()
        assert "nonuniform" in h_text

    def test_h_field_contains_snow_depth(self, case_dir: Path, sample_data: dict):
        h_text = (case_dir / "0" / "h").read_text()
        depth = sample_data["snowDepthM"]
        assert str(depth) in h_text

    def test_h_field_correct_face_count(self, case_dir: Path, sample_data: dict):
        """Number of values matches 2 * (rows-1) * (cols-1) triangles."""
        dem = sample_data["dem"]
        expected = (dem["rows"] - 1) * (dem["cols"] - 1) * 2

        h_text = (case_dir / "0" / "h").read_text()
        # The count appears as a standalone number before the '(' in List
        lines = h_text.splitlines()
        for i, line in enumerate(lines):
            if line.strip() == "(":
                count = int(lines[i - 1].strip())
                assert count == expected
                break
        else:
            pytest.fail("Could not find value list in h field")

    def test_h_field_release_faces_nonzero(self, case_dir: Path, sample_data: dict):
        """At least some faces have non-zero depth."""
        h_text = (case_dir / "0" / "h").read_text()
        depth = sample_data["snowDepthM"]
        assert h_text.count(str(depth)) >= 1

    def test_us_field_uniform_zero(self, case_dir: Path):
        us_text = (case_dir / "0" / "Us").read_text()
        assert "uniform (0 0 0)" in us_text


# ---- AC6: produces a runnable case from sample_input.json ----

class TestSampleInputIntegration:
    def test_from_sample_input(self):
        """Full integration: generate case from the actual sample_input.json."""
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "case"
            result = generate_case(SAMPLE_INPUT, out)
            assert result == out
            assert result.is_dir()

            # All critical files present
            critical = [
                "system/controlDict",
                "system/blockMeshDict",
                "system/fvSchemes",
                "system/fvSolution",
                "system/faSchemes",
                "system/faSolution",
                "system/decomposeParDict",
                "system/faMesh/faMeshDefinition",
                "constant/g",
                "constant/transportProperties",
                "constant/triSurface/terrain.stl",
                "0/h",
                "0/Us",
            ]
            for f in critical:
                assert (result / f).is_file(), f"Missing: {f}"

    def test_block_mesh_dict_domain_dimensions(self, sample_data: dict):
        """blockMeshDict vertex coords match DEM dimensions."""
        with tempfile.TemporaryDirectory() as tmp:
            inp = Path(tmp) / "input.json"
            inp.write_text(json.dumps(sample_data))
            out = Path(tmp) / "case"
            generate_case(inp, out)

            bmd = (out / "system" / "blockMeshDict").read_text()
            dem = sample_data["dem"]
            x_max = (dem["cols"] - 1) * dem["cellSize"]
            y_max = (dem["rows"] - 1) * dem["cellSize"]
            assert f"{x_max:.2f}" in bmd
            assert f"{y_max:.2f}" in bmd


# ---- Validation ----

class TestValidation:
    def test_valid_input_passes(self, sample_data: dict):
        assert validate_input(sample_data) == []

    def test_wrong_schema_version(self, sample_data: dict):
        sample_data["schemaVersion"] = 2
        errors = validate_input(sample_data)
        assert any("schemaVersion" in e for e in errors)

    def test_missing_dem(self, sample_data: dict):
        del sample_data["dem"]
        errors = validate_input(sample_data)
        assert len(errors) > 0

    def test_empty_release_cells(self, sample_data: dict):
        sample_data["releaseCells"] = []
        errors = validate_input(sample_data)
        assert any("releaseCells" in e for e in errors)

    def test_mu_out_of_range(self, sample_data: dict):
        sample_data["snowProfile"]["frictionMu"] = 0.8
        errors = validate_input(sample_data)
        assert any("frictionMu" in e for e in errors)

    def test_xi_out_of_range(self, sample_data: dict):
        sample_data["snowProfile"]["frictionXi"] = 100
        errors = validate_input(sample_data)
        assert any("frictionXi" in e for e in errors)

    def test_invalid_release_cell_coords(self, sample_data: dict):
        sample_data["releaseCells"].append([999, 999])
        errors = validate_input(sample_data)
        assert any("out of DEM bounds" in e for e in errors)

    def test_zero_snow_depth(self, sample_data: dict):
        sample_data["snowDepthM"] = 0
        errors = validate_input(sample_data)
        assert any("snowDepthM" in e for e in errors)

    def test_generate_rejects_invalid(self):
        """generate_case raises ValueError on invalid input."""
        with tempfile.TemporaryDirectory() as tmp:
            bad = Path(tmp) / "bad.json"
            bad.write_text(json.dumps({"schemaVersion": 2}))
            with pytest.raises(ValueError, match="validation failed"):
                generate_case(bad, Path(tmp) / "out")
